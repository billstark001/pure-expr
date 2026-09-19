import { describe, expect, test } from 'vitest'

import {
  allowAllCalls,
  type ContextPolicy,
  compileExpression,
  createBindingStore,
  createEvaluationEnvironment,
  createEvaluator,
  evaluate,
  parseExpression,
} from '../src/index.js'

const ALLOW_CALLS = { isCallableAllowed: allowAllCalls }

describe('evaluation context policies', () => {
  test('compiled expressions take a fresh snapshot for every evaluation', () => {
    const context = { value: 1 }
    const compiled = compileExpression('value', {
      contextPolicy: { isolation: 'shallow-snapshot' },
    })

    expect(compiled.evaluate(context)).toBe(1)
    context.value = 2
    expect(compiled.evaluate(context)).toBe(2)
  })

  test('compiled evaluators snapshot their policy configuration', () => {
    const context = {
      value: 1,
      mutate() {
        context.value = 2
      },
    }
    const policy: ContextPolicy = { isolation: 'shallow-snapshot' }
    const compiled = compileExpression('mutate(), value', {
      ...ALLOW_CALLS,
      contextPolicy: policy,
    })
    ;(policy as { isolation: 'reference' | 'shallow-snapshot' }).isolation = 'reference'

    expect(compiled.evaluate(context)).toBe(1)
  })

  test('reference and shallow snapshots differ for changes during an evaluation', () => {
    const referenceContext = {
      value: 1,
      mutate() {
        referenceContext.value = 2
      },
    }
    expect(evaluate('mutate(), value', referenceContext, ALLOW_CALLS)).toBe(2)

    const snapshotContext = {
      value: 1,
      mutate() {
        snapshotContext.value = 2
      },
    }
    expect(
      evaluate('mutate(), value', snapshotContext, {
        ...ALLOW_CALLS,
        contextPolicy: { isolation: 'shallow-snapshot' },
      }),
    ).toBe(1)
    expect(snapshotContext.value).toBe(2)
  })

  test('deep snapshots isolate data while capabilities remain callable by reference', () => {
    const data = { item: { count: 1 } }
    const environment = createEvaluationEnvironment({
      data,
      dataPolicy: { isolation: 'deep-snapshot' },
      capabilities: {
        mutate(item: { count: number }) {
          item.count = 5
          return item.count
        },
      },
    })

    expect(evaluate('mutate(item), item.count', environment, ALLOW_CALLS)).toBe(5)
    expect(data.item.count).toBe(1)
  })

  test('deep-frozen snapshots prevent structural mutation without freezing caller data', () => {
    const data = { item: { count: 1 } }
    const environment = createEvaluationEnvironment({
      data,
      dataPolicy: { isolation: 'deep-snapshot', freeze: 'deep' },
      capabilities: {
        mutate(item: { count: number }) {
          item.count = 5
        },
      },
    })

    expect(() => evaluate('mutate(item)', environment, ALLOW_CALLS)).toThrow()
    expect(Object.isFrozen(data)).toBe(false)
    expect(Object.isFrozen(data.item)).toBe(false)
  })

  test('invalid freeze and isolation combinations are rejected at runtime', () => {
    expect(() =>
      evaluate(
        'value',
        { value: 1 },
        {
          contextPolicy: { isolation: 'reference', freeze: 'deep' } as never,
        },
      ),
    ).toThrow('caller-owned')
    expect(() =>
      evaluate(
        'value',
        { value: 1 },
        {
          contextPolicy: { isolation: 'shallow-snapshot', freeze: 'deep' } as never,
        },
      ),
    ).toThrow('borrowed nested values')
  })

  test('escaped arrows inherit reference or snapshot capture semantics', () => {
    const context = { bonus: 1 }
    const referenceArrow = evaluate('x => x + bonus', context) as (value: number) => number
    const snapshotArrow = evaluate('x => x + bonus', context, {
      contextPolicy: { isolation: 'shallow-snapshot' },
    }) as (value: number) => number

    context.bonus = 4
    expect(referenceArrow(1)).toBe(5)
    expect(snapshotArrow(1)).toBe(2)
  })
})

describe('mutable binding stores', () => {
  test('assignments remain disabled by default', () => {
    expect(() => evaluate('score = 2', { score: 1 })).toThrow('read-only expressions')
  })

  test('the parser can explicitly produce restricted assignment nodes', () => {
    expect(parseExpression('score += 2', { allowAssignments: true })).toMatchObject({
      type: 'AssignmentExpression',
      operator: '+=',
      left: { type: 'Identifier', name: 'score' },
    })
    expect(() => parseExpression('player.score = 2', { allowAssignments: true })).toThrow(
      'Only identifier bindings',
    )
  })

  test('overlay writes are visible during one evaluation and then discarded', () => {
    const context = { score: 1 }
    expect(evaluate('score = 2, score + 1', context, { writes: 'overlay' })).toBe(3)
    expect(context.score).toBe(1)
  })

  test.each(['default', 'performance'] as const)(
    '%s overlay writes cross arrow call frames within one evaluation',
    (functionMode) => {
      const context = { score: 1 }
      expect(
        evaluate('(() => score = 2)(), score', context, { writes: 'overlay', functionMode }),
      ).toBe(2)
      expect(context.score).toBe(1)
    },
  )

  test('escaped arrows retain their evaluation overlay', () => {
    const context = { score: 1 }
    const read = evaluate('score = 2, () => score', context, { writes: 'overlay' }) as () => number

    expect(read()).toBe(2)
    expect(context.score).toBe(1)
  })

  test('commit writes update plain record inputs', () => {
    const context = { score: 1 }
    expect(evaluate('score += 2', context, { writes: 'commit' })).toBe(3)
    expect(context.score).toBe(3)
  })

  test('root writes cannot target blocked prototype-related names', () => {
    const context = {} as Record<string, unknown>
    expect(() => evaluate('__proto__ = 1', context, { writes: 'commit' })).toThrow('not writable')
    expect(Object.getPrototypeOf(context)).toBe(Object.prototype)
  })

  test('commit writes update an explicit variable store', () => {
    const values = { score: 1 }
    const environment = createEvaluationEnvironment({
      data: { step: 2 },
      variables: createBindingStore(values),
    })

    expect(evaluate('score += step', environment, { writes: 'commit' })).toBe(3)
    expect(values.score).toBe(3)
  })

  test('logical assignments short-circuit their right-hand side', () => {
    const values: Record<string, unknown> = { yes: true, no: false, missing: null, hits: 0 }
    values.hit = () => {
      values.hits = Number(values.hits) + 1
      return 9
    }

    expect(
      evaluate('yes ||= hit(), no &&= hit(), missing ??= hit(), missing', values, {
        ...ALLOW_CALLS,
        writes: 'commit',
      }),
    ).toBe(9)
    expect(values.hits).toBe(1)
  })

  test.each(['default', 'performance'] as const)(
    '%s arrows update captured lexical bindings without writing context',
    (functionMode) => {
      expect(
        evaluate(
          '((x) => ((bump) => (bump(), bump(), x))(() => x += 1))(1)',
          {},
          { writes: 'overlay', functionMode },
        ),
      ).toBe(3)
    },
  )

  test('transactions expose changes and commit atomically', () => {
    const context = { score: 1 }
    const transaction = evaluate('score += 2, bonus = 4, score + bonus', context, {
      writes: 'transaction',
    })

    expect(transaction.value).toBe(7)
    expect([...transaction.changes]).toEqual([
      ['score', 3],
      ['bonus', 4],
    ])
    ;(transaction.changes as Map<string, unknown>).set('injected', true)
    expect(context).toEqual({ score: 1 })
    transaction.commit()
    expect(transaction.status).toBe('committed')
    expect(context).toEqual({ score: 3, bonus: 4 })
    expect(context).not.toHaveProperty('injected')
  })

  test('failed transaction commits restore changes already written to a binding store', () => {
    const values = new Map<string, unknown>([
      ['first', 1],
      ['second', 1],
    ])
    const variables = {
      has: (name: string) => values.has(name),
      get: (name: string) => values.get(name),
      set: (name: string, value: unknown) => {
        if (name === 'second') throw new Error('second rejected')
        values.set(name, value)
      },
      delete: (name: string) => values.delete(name),
    }
    const environment = createEvaluationEnvironment({ variables })
    const transaction = evaluate('first = 2, second = 2', environment, {
      writes: 'transaction',
    })

    expect(() => transaction.commit()).toThrow('second rejected')
    expect(Object.fromEntries(values)).toEqual({ first: 1, second: 1 })
    expect(transaction.status).toBe('pending')
    transaction.rollback()
  })

  test('transaction commits reject unrecoverable new bindings before writing', () => {
    const values = new Map<string, unknown>([['existing', 1]])
    const variables = {
      has: (name: string) => values.has(name),
      get: (name: string) => values.get(name),
      set: (name: string, value: unknown) => values.set(name, value),
    }
    const environment = createEvaluationEnvironment({ variables })
    const transaction = evaluate('existing = 2, created = 3', environment, {
      writes: 'transaction',
    })

    expect(() => transaction.commit()).toThrow('does not support deletion')
    expect(Object.fromEntries(values)).toEqual({ existing: 1 })
  })

  test('custom binding stores can provide atomic batch application', () => {
    const values = new Map<string, unknown>([
      ['first', 1],
      ['second', 1],
    ])
    let applyCalls = 0
    const variables = {
      has: (name: string) => values.has(name),
      get: (name: string) => values.get(name),
      set: (name: string, value: unknown) => values.set(name, value),
      applyChanges: (changes: ReadonlyMap<string, unknown>) => {
        applyCalls += 1
        for (const [name, value] of changes) values.set(name, value)
      },
    }
    const environment = createEvaluationEnvironment({ variables })
    const transaction = evaluate('first = 2, second = 3', environment, {
      writes: 'transaction',
    })

    transaction.commit()
    expect(applyCalls).toBe(1)
    expect(Object.fromEntries(values)).toEqual({ first: 2, second: 3 })
  })

  test('transactions can be rolled back and failed evaluations never write through', () => {
    const context = { score: 1 }
    const transaction = evaluate('score = 5', context, { writes: 'transaction' })
    transaction.rollback()
    expect(transaction.status).toBe('rolled-back')
    expect(context.score).toBe(1)

    expect(() => evaluate('score = 8, missing.value', context, { writes: 'transaction' })).toThrow()
    expect(context.score).toBe(1)
  })

  test('compiled transactional expressions do not retain an old input', () => {
    const compiled = compileExpression('score += 1', { writes: 'transaction' })
    const first = { score: 1 }
    const second = { score: 10 }

    const firstTransaction = compiled.evaluate(first)
    const secondTransaction = compiled.evaluate(second)
    expect(firstTransaction.value).toBe(2)
    expect(secondTransaction.value).toBe(11)
    secondTransaction.commit()
    expect(first.score).toBe(1)
    expect(second.score).toBe(11)
  })

  test('transactional evaluator factories expose transaction results', () => {
    const run = createEvaluator({ writes: 'transaction' })
    const context = { value: 1 }
    const transaction = run('value += 1', context)

    expect(transaction.value).toBe(2)
    transaction.commit()
    expect(context.value).toBe(2)
  })

  test('commit mode rejects non-reference isolation', () => {
    expect(() =>
      evaluate(
        'score = 2',
        { score: 1 },
        {
          writes: 'commit',
          contextPolicy: { isolation: 'shallow-snapshot' },
        },
      ),
    ).toThrow('require reference')
  })
})
