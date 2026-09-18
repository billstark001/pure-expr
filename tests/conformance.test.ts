import { describe, expect, test } from 'vitest'

import corpusData from '../conformance/v1/corpus.json' with { type: 'json' }

import {
  allowAllCalls,
  compileExpression,
  compileTemplate,
  defaultCallPermissionPolicy,
  evaluate,
  JSEvalError,
  JSEvaluator,
  JSLexError,
  JSParseError,
  parseExpression,
  parseTemplate,
  renderTemplate,
  tokenizeExpression,
} from '../src/index.js'

interface Corpus {
  schemaVersion: number
  corpusVersion: string
  legacyTestCount: number
  caseCount: number
  cases: CorpusCase[]
}

interface CorpusCase {
  id: string
  sourceTest: { file: string; suite: string; name: string }
  checks: CorpusCheck[]
}

interface CorpusCheck {
  op: string
  source?: string
  context?: unknown
  contexts?: unknown[]
  baseContext?: unknown
  options?: Record<string, unknown>
  expect: CorpusExpectation
  observeTrace?: boolean
  observePrototype?: boolean
  includeSource?: boolean
  callable?: string
  receiver?: unknown
  kind?: string
}

interface CorpusExpectation {
  value?: unknown
  match?: unknown
  paths?: Array<{ path: string; equals?: unknown; contains?: string }>
  error?: {
    kind: string
    messageIncludes: string[]
    start?: number
    startType?: string
    posType?: string
  }
  trace?: unknown[]
}

interface FixtureState {
  trace: unknown[]
  firstTemplateObject?: TemplateStringsArray
}

interface CheckOutcome {
  value?: unknown
  error?: unknown
  state: FixtureState
}

const corpus = corpusData as Corpus

function decodeFixture(value: unknown, state: FixtureState): unknown {
  if (Array.isArray(value)) return value.map((entry) => decodeFixture(entry, state))
  if (typeof value !== 'object' || value === null) return value

  const record = value as Record<string, unknown>
  const marker = record.$conformance
  if (typeof marker === 'string') {
    switch (marker) {
      case 'undefined':
        return undefined
      case 'bigint':
        return BigInt(record.value as string)
      case 'regex':
        return new RegExp(record.source as string, record.flags as string)
      case 'builtin':
        if (record.name === 'Math') return Math
        if (record.name === 'Array') return Array
        throw new Error(`Unknown builtin fixture: ${String(record.name)}`)
      case 'callable':
        return createCallable(record, state)
      case 'class-instance': {
        class Scope {}
        const prototype = decodeFixture(record.prototype ?? {}, state) as Record<string, unknown>
        Object.assign(Scope.prototype, prototype)
        return Object.assign(new Scope(), decodeFixture(record.own ?? {}, state))
      }
      case 'accessor-object': {
        const result = {}
        Object.defineProperty(result, record.property as string, {
          enumerable: true,
          get() {
            state.trace.push({ event: 'getter-invoked', property: record.property })
            return decodeFixture(record.value, state)
          },
        })
        return result
      }
      case 'circular-context': {
        const result = { value: decodeFixture(record.value, state) } as Record<string, unknown>
        result.self = result
        return result
      }
      case 'json-object':
        return JSON.parse(record.source as string)
      default:
        throw new Error(`Unknown conformance fixture marker: ${marker}`)
    }
  }

  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(record)) result[key] = decodeFixture(entry, state)
  return result
}

function createCallable(
  descriptor: Record<string, unknown>,
  state: FixtureState,
): (...args: unknown[]) => unknown {
  switch (descriptor.name) {
    case 'fail-if-called':
      return () => {
        throw new Error('fail-if-called fixture was invoked')
      }
    case 'first-argument':
      return (value) => value
    case 'multiply':
      return (value) => Number(value) * Number(descriptor.factor)
    case 'greet':
      return (value) => `Hello, ${String(value)}!`
    case 'upper':
      return (value) => String(value).toUpperCase()
    case 'square':
      return (value) => Number(value) * Number(value)
    case 'trim':
      return (value) => String(value).trim()
    case 'collect-count':
      return (...values) => values.length
    case 'no-op':
      return () => undefined
    case 'record-argument':
      return (value) => {
        state.trace.push(value)
        return value
      }
    case 'tag-concat':
      return (strings, ...values) => {
        const template = strings as TemplateStringsArray
        return `${template.raw.join('')}|${values.join(',')}`
      }
    case 'receiver-tag':
      return function (this: { value: number }, ...args: unknown[]) {
        const strings = args[0] as TemplateStringsArray
        return this.value + strings.length - 1
      }
    case 'inspect-template':
      return (strings) => {
        const template = strings as TemplateStringsArray
        state.trace.push({
          event: 'template-object',
          sameAsFirst:
            state.firstTemplateObject === undefined ? null : state.firstTemplateObject === template,
        })
        state.firstTemplateObject ??= template
        return {
          cooked: template[0],
          raw: template.raw[0],
          frozen: Object.isFrozen(template),
          rawFrozen: Object.isFrozen(template.raw),
          rawEnumerable: Object.prototype.propertyIsEnumerable.call(template, 'raw'),
        }
      }
    case 'inspect-template-flags':
      return (strings) => {
        const template = strings as TemplateStringsArray
        return {
          frozen: Object.isFrozen(template),
          rawFrozen: Object.isFrozen(template.raw),
          rawEnumerable: Object.prototype.propertyIsEnumerable.call(template, 'raw'),
        }
      }
    case 'template-first-and-raw':
      return (strings) => {
        const template = strings as TemplateStringsArray
        return [template[0], template.raw[0]]
      }
    default:
      throw new Error(`Unknown callable fixture: ${String(descriptor.name)}`)
  }
}

function decodeOptions(options: Record<string, unknown> | undefined): Record<string, unknown> {
  const source = options ?? {}
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (key === 'callPolicy') {
      if (value !== 'allow-all') throw new Error(`Unknown call policy fixture: ${String(value)}`)
      result.isCallableAllowed = allowAllCalls
    } else if (key === 'evalOptions') {
      result.evalOptions = decodeOptions(value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }
  return result
}

function encodeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === undefined) return { $conformance: 'undefined' }
  if (typeof value === 'bigint') return { $conformance: 'bigint', value: value.toString() }
  if (value instanceof RegExp) {
    return { $conformance: 'regex', source: value.source, flags: value.flags }
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $conformance: 'number', value: 'nan' }
    if (value === Infinity) return { $conformance: 'number', value: 'infinity' }
    if (value === -Infinity) return { $conformance: 'number', value: '-infinity' }
    if (Object.is(value, -0)) return { $conformance: 'number', value: '-0' }
    return value
  }
  if (Array.isArray(value)) return value.map((entry) => encodeValue(entry, seen))
  if (typeof value !== 'object' || value === null) return value
  if (seen.has(value)) return { $conformance: 'circular-reference' }

  seen.add(value)
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    result[key] = encodeValue((value as Record<string, unknown>)[key], seen)
  }
  seen.delete(value)
  return result
}

function observedValue(value: unknown, check: CorpusCheck, state: FixtureState): unknown {
  if (check.observePrototype) {
    const object = value as Record<string, unknown>
    const prototype = Object.getPrototypeOf(object) as Record<string, unknown> | null
    return {
      value: encodeValue(value),
      prototype: prototype === null ? 'null' : prototype === Object.prototype ? 'object' : 'custom',
      prototypeProperties:
        prototype === null || prototype === Object.prototype ? {} : encodeValue(prototype),
    }
  }
  if (check.observeTrace) return { value: encodeValue(value), trace: encodeValue(state.trace) }
  return encodeValue(value)
}

async function executeCheck(check: CorpusCheck, state: FixtureState): Promise<unknown> {
  const options = decodeOptions(check.options)
  const source = check.source ?? ''

  switch (check.op) {
    case 'evaluate': {
      const context = decodeFixture(check.context ?? {}, state) as Record<string, unknown>
      const value = evaluate(source, context, options)
      return observedValue(value, check, state)
    }
    case 'parse-expression':
      return encodeValue(parseExpression(source, options))
    case 'tokenize-expression':
      return tokenizeExpression(source, options).map((token) => token.raw)
    case 'parse-template':
      return encodeValue(parseTemplate(source, options))
    case 'render-template':
      return encodeValue(
        renderTemplate(
          source,
          decodeFixture(check.context ?? {}, state) as Record<string, unknown>,
          options,
        ),
      )
    case 'compile-evaluate': {
      const compiled = compileExpression(source, options)
      const values = (check.contexts ?? []).map((context) =>
        encodeValue(compiled.evaluate(decodeFixture(context, state) as Record<string, unknown>)),
      )
      if (check.includeSource) return { source: compiled.source, values }
      if (check.observeTrace) return { values, trace: encodeValue(state.trace) }
      return values
    }
    case 'compiled-nested-evaluate': {
      const compiled = compileExpression(source, options)
      return encodeValue(
        compiled.evaluate({
          value: 1,
          fn: (value: number) =>
            compiled.evaluate({
              value: value + 1,
              fn: (inner: number) => inner * 2,
            }),
        }),
      )
    }
    case 'compile-template-render': {
      const compiled = compileTemplate(source, options)
      const values = (check.contexts ?? []).map((context) =>
        encodeValue(compiled.render(decodeFixture(context, state) as Record<string, unknown>)),
      )
      return check.includeSource ? { source: compiled.source, values } : values
    }
    case 'evaluator-evaluate': {
      const evaluator = new JSEvaluator(
        decodeFixture(check.baseContext ?? {}, state) as Record<string, unknown>,
        options,
      )
      const ast = parseExpression(source, options)
      return (check.contexts ?? []).map((context) =>
        encodeValue(
          context === null
            ? evaluator.evaluate(ast)
            : evaluator.evaluate(ast, decodeFixture(context, state) as Record<string, unknown>),
        ),
      )
    }
    case 'call-permission': {
      if (check.callable !== 'String.prototype.normalize') {
        throw new Error(`Unknown call-permission fixture: ${String(check.callable)}`)
      }
      return defaultCallPermissionPolicy({
        kind: check.kind as 'call',
        fn: String.prototype.normalize,
        thisValue: check.receiver,
        node: parseExpression(source),
      })
    }
    default:
      throw new Error(`Unknown conformance operation: ${check.op}`)
  }
}

function errorKind(error: unknown): string {
  if (error instanceof JSLexError) return 'lex'
  if (error instanceof JSParseError) return 'parse'
  if (error instanceof JSEvalError) return 'eval'
  return 'host'
}

function readPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value
  return pointer
    .split('/')
    .slice(1)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<unknown>((current, part) => {
      if (current === null || current === undefined) return undefined
      return (current as Record<string, unknown>)[part]
    }, value)
}

function assertExpectation(outcome: CheckOutcome, expected: CorpusExpectation): void {
  if (expected.error) {
    expect(outcome.error).toBeDefined()
    const error = outcome.error as Error & { start?: number; pos?: number }
    expect(errorKind(error)).toBe(expected.error.kind)
    for (const snippet of expected.error.messageIncludes) {
      if (snippet) expect(error.message).toContain(snippet)
    }
    if (expected.error.start !== undefined) expect(error.start).toBe(expected.error.start)
    if (expected.error.startType !== undefined) {
      expect(typeof error.start).toBe(expected.error.startType)
    }
    if (expected.error.posType !== undefined) expect(typeof error.pos).toBe(expected.error.posType)
    if (expected.trace !== undefined)
      expect(encodeValue(outcome.state.trace)).toEqual(expected.trace)
    return
  }

  if (outcome.error) throw outcome.error
  if ('value' in expected) expect(outcome.value).toEqual(expected.value)
  if (expected.match !== undefined) {
    expect(outcome.value).toMatchObject(expected.match as Record<string, unknown>)
  }
  for (const assertion of expected.paths ?? []) {
    const actual = readPointer(outcome.value, assertion.path)
    if ('equals' in assertion) expect(actual).toEqual(assertion.equals)
    if (assertion.contains !== undefined) expect(actual).toContain(assertion.contains)
  }
}

describe('language-neutral conformance corpus', () => {
  test('metadata remains frozen to the 182 legacy tests', () => {
    expect(corpus.schemaVersion).toBe(1)
    expect(corpus.legacyTestCount).toBe(182)
    expect(corpus.caseCount).toBe(182)
    expect(corpus.cases).toHaveLength(182)
    expect(new Set(corpus.cases.map((entry) => entry.id)).size).toBe(182)
  })

  for (const entry of corpus.cases) {
    test(entry.id, async () => {
      for (const check of entry.checks) {
        const state: FixtureState = { trace: [] }
        const outcome: CheckOutcome = { state }
        try {
          outcome.value = await executeCheck(check, state)
        } catch (error) {
          outcome.error = error
        }
        assertExpectation(outcome, check.expect)
      }
    })
  }
})
