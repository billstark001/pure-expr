import { describe, expect, test } from 'vitest'
import {
  allowAllCalls,
  compileExpression,
  evaluate,
  type EvalOptions,
  type JSEvalError,
  JSLexError,
  JSParseError,
  parseExpression,
} from '../src/expr/index.js'

// #region Test helpers

function ev(expr: string, ctx: Record<string, unknown> = {}, opts: EvalOptions = {}): unknown {
  return evaluate(expr, ctx, opts)
}

const ALLOW_ALL_CALLS: EvalOptions = Object.freeze({
  isCallableAllowed: allowAllCalls,
})

// #endregion

// #region Evaluator coverage

describe('evaluator', () => {
  test('integer literal', () => expect(ev('42')).toBe(42))
  test('float literal', () => expect(ev('3.14')).toBe(3.14))
  test('hex literal', () => expect(ev('0xFF')).toBe(255))
  test('octal literal', () => expect(ev('0o17')).toBe(15))
  test('binary literal', () => expect(ev('0b1010')).toBe(10))
  test('bigint literal', () => expect(ev('9007199254740993n')).toBe(9007199254740993n))
  test('string double quotes', () => expect(ev('"hello"')).toBe('hello'))
  test('string single quotes', () => expect(ev("'world'")).toBe('world'))
  test('string escape sequences', () => expect(ev('"a\\nb"')).toBe('a\nb'))
  test('boolean true', () => expect(ev('true')).toBe(true))
  test('boolean false', () => expect(ev('false')).toBe(false))
  test('null literal', () => expect(ev('null')).toBe(null))
  test('undefined literal', () => expect(ev('undefined')).toBe(undefined))
  test('regex literal', () => {
    const r = ev('/abc/gi') as RegExp
    if (!(r instanceof RegExp)) throw new Error('Expected RegExp instance')
    if (r.source !== 'abc') throw new Error('Wrong source')
    if (r.flags !== 'gi') throw new Error('Wrong flags')
  })

  // ── Operator precedence ───────────────────────────────────────────
  test('precedence: * over +', () => expect(ev('2 + 3 * 4')).toBe(14))
  test('precedence: grouping overrides', () => expect(ev('(2 + 3) * 4')).toBe(20))
  test('precedence: ** right-assoc', () => expect(ev('2 ** 3 ** 2')).toBe(512)) // 2**(3**2)=512
  test('precedence: unary before **', () => expect(ev('-2 ** 2')).toBe(-4)) // -(2**2)
  test('precedence: bitwise < arithmetic', () => expect(ev('1 + 2 | 4')).toBe(7)) // (1+2)|4
  test('left-assoc subtraction', () => expect(ev('10 - 3 - 2')).toBe(5))
  test('comparison chains', () => expect(ev('1 < 2 === true')).toBe(true))
  test('logical AND short-circuit', () => {
    let called = false
    ev('false && fn()', {
      fn: () => {
        called = true
      },
    })
    if (called) throw new Error('fn should not have been called')
  })
  test('logical OR short-circuit', () => {
    let called = false
    ev('true || fn()', {
      fn: () => {
        called = true
      },
    })
    if (called) throw new Error('fn should not have been called')
  })
  test('nullish coalescing', () => expect(ev('null ?? "default"')).toBe('default'))
  test('nullish coalescing skips 0 and false', () => {
    expect(ev('0 ?? 42')).toBe(0)
    expect(ev('false ?? 42')).toBe(false)
  })
  test('nullish coalescing rejects mixing with && or || without parentheses', () => {
    expect(() => ev('1 ?? 2 || 3')).toThrow('without parentheses')
    expect(() => ev('1 && 2 ?? 3')).toThrow('without parentheses')
  })
  test('nullish coalescing allows grouped mixes with && or ||', () => {
    expect(ev('(1 ?? 2) || 3')).toBe(1)
    expect(ev('1 ?? (2 || 3)')).toBe(1)
  })

  // ── Ternary ───────────────────────────────────────────────────────
  test('ternary basic', () => expect(ev('1 > 0 ? "yes" : "no"')).toBe('yes'))
  test('ternary right-assoc', () => expect(ev('false ? 1 : true ? 2 : 3')).toBe(2))
  test('ternary with complex expressions', () =>
    expect(ev('x > 10 ? x * 2 : x + 1', { x: 5 })).toBe(6))

  // ── Arithmetic and math ───────────────────────────────────────────
  test('modulo', () => expect(ev('17 % 5')).toBe(2))
  test('division', () => expect(ev('7 / 2')).toBe(3.5))
  test('bitwise NOT', () => expect(ev('~5')).toBe(-6))
  test('left shift', () => expect(ev('1 << 8')).toBe(256))
  test('unsigned right shift', () => expect(ev('-1 >>> 0')).toBe(4294967295))

  // ── String operations ─────────────────────────────────────────────
  test('string concatenation', () => expect(ev('"foo" + "bar"')).toBe('foobar'))
  test('template literal basic', () => expect(ev('`hello world`')).toBe('hello world'))
  test('template literal with expression', () =>
    expect(ev('`${x} + ${y} = ${x + y}`', { x: 3, y: 4 })).toBe('3 + 4 = 7'))
  test('template literal nested', () => expect(ev('`${ `inner ${n}` }`', { n: 7 })).toBe('inner 7'))
  test('tagged template literal', () => {
    const tag = (strings: TemplateStringsArray, ...vals: unknown[]) =>
      `${strings.raw.join('')}|${vals.join(',')}`
    expect(ev('tag`a${1}b${2}c`', { tag }, ALLOW_ALL_CALLS)).toBe('abc|1,2')
  })
  test('tagged template literal preserves method receivers', () => {
    expect(
      ev(
        'obj.tag`x`',
        {
          obj: {
            value: 42,
            tag(this: { value: number }, strings: TemplateStringsArray) {
              return this.value + strings.length - 1
            },
          },
        },
        ALLOW_ALL_CALLS,
      ),
    ).toBe(42)
  })
  test('template literal can be disabled', () => {
    expect(() => ev('`hello`', {}, { allowTemplateLiterals: false })).toThrow('not enabled')
  })
  test('tagged template literal can be disabled independently', () => {
    expect(() =>
      ev(
        'tag`hello`',
        { tag: (strings: TemplateStringsArray) => strings[0] },
        {
          allowTaggedTemplates: false,
        },
      ),
    ).toThrow('not enabled')
  })
  test('tagged template literal passes a cached spec-like template object by default', () => {
    const seen: TemplateStringsArray[] = []
    const compiled = compileExpression('tag`a\\nb${value}c`', ALLOW_ALL_CALLS)
    const tag = (strings: TemplateStringsArray) => {
      seen.push(strings)
      return {
        cooked: strings[0],
        raw: strings.raw[0],
        frozen: Object.isFrozen(strings),
        rawFrozen: Object.isFrozen(strings.raw),
        rawEnumerable: Object.prototype.propertyIsEnumerable.call(strings, 'raw'),
      }
    }

    const first = compiled.evaluate({ tag, value: 1 })
    const second = compiled.evaluate({ tag, value: 2 })

    expect(first).toEqual({
      cooked: 'a\nb',
      raw: 'a\\nb',
      frozen: true,
      rawFrozen: true,
      rawEnumerable: false,
    })
    expect(seen[0]).toBe(seen[1])
    expect(second).toEqual(first)
  })
  test('compiled expressions do not leak nested evaluation context', () => {
    const compiled = compileExpression('fn(value) + value', ALLOW_ALL_CALLS)

    const result = compiled.evaluate({
      value: 1,
      fn: (value: number) =>
        compiled.evaluate({
          value: value + 1,
          fn: (inner: number) => inner * 2,
        }),
    })

    expect(result).toBe(7)
  })
  test('tagged template literal supports loose array emulation mode', () => {
    const tag = (strings: TemplateStringsArray) => ({
      frozen: Object.isFrozen(strings),
      rawFrozen: Object.isFrozen(strings.raw),
      rawEnumerable: Object.prototype.propertyIsEnumerable.call(strings, 'raw'),
    })

    expect(ev('tag`x`', { tag }, { ...ALLOW_ALL_CALLS, taggedTemplateArrayMode: 'loose' })).toEqual(
      {
        frozen: false,
        rawFrozen: false,
        rawEnumerable: true,
      },
    )
  })
  test('untagged template literal rejects invalid escapes', () => {
    expect(() => ev('`bad \\u{110000}`')).toThrow('Invalid escape sequence')
  })
  test('tagged template literal preserves raw text and undefined cooked values for invalid escapes', () => {
    const tag = (strings: TemplateStringsArray) => [strings[0], strings.raw[0]]
    expect(ev('tag`bad \\u{110000}`', { tag }, ALLOW_ALL_CALLS)).toEqual([
      undefined,
      'bad \\u{110000}',
    ])
  })
  test('template placeholder expressions handle regex literals, comments, and nested braces', () => {
    expect(
      ev(
        '`${ /* keep */ /a{2}/.test(text) ? `{${value}}` : "no" }`',
        {
          text: 'aa',
          value: 'x',
        },
        ALLOW_ALL_CALLS,
      ),
    ).toBe('{x}')
  })

  // ── Member access ─────────────────────────────────────────────────
  test('dot member access', () => expect(ev('obj.name', { obj: { name: 'Alice' } })).toBe('Alice'))
  test('computed member access', () => expect(ev('obj["key"]', { obj: { key: 42 } })).toBe(42))
  test('chained member access', () => expect(ev('a.b.c', { a: { b: { c: 99 } } })).toBe(99))
  test('optional chaining: null base', () => expect(ev('obj?.name', { obj: null })).toBe(undefined))
  test('optional chaining: defined base', () =>
    expect(ev('obj?.name', { obj: { name: 'Bob' } })).toBe('Bob'))
  test('optional chaining: computed', () =>
    expect(ev('obj?.[key]', { obj: null, key: 'x' })).toBe(undefined))
  test('optional chaining: call', () => expect(ev('fn?.()', { fn: null })).toBe(undefined))
  test('array index', () => expect(ev('arr[1]', { arr: [10, 20, 30] })).toBe(20))

  // ── Function calls ────────────────────────────────────────────────
  test('simple call', () =>
    expect(ev('double(5)', { double: (x: number) => x * 2 }, ALLOW_ALL_CALLS)).toBe(10))
  test('method call', () =>
    expect(
      ev('obj.greet("world")', { obj: { greet: (s: string) => `Hello, ${s}!` } }, ALLOW_ALL_CALLS),
    ).toBe('Hello, world!'))
  test('spread in call args', () =>
    expect(ev('Math.max(...nums)', { Math, nums: [1, 5, 3, 7, 2] })).toBe(7))
  test('chained calls', () => expect(ev('"  hello  ".trim().toUpperCase()', {})).toBe('HELLO'))
  test('default call policy allows newer safe string methods', () => {
    expect(ev('"A\u030A".normalize("NFC")')).toBe('Å')
    expect(ev('"😊".codePointAt(0)')).toBe(0x1f60a)
  })
  test('default call policy allows newer safe array methods', () => {
    expect(ev('[1, [2, [3]]].flat(2)')).toEqual([1, 2, 3])
  })

  // ── Array and object literals ─────────────────────────────────────
  test('array literal', () => expect(ev('[1, 2, 3]')).toEqual([1, 2, 3]))
  test('array spread', () => expect(ev('[...a, 4]', { a: [1, 2, 3] })).toEqual([1, 2, 3, 4]))
  test('object literal', () => expect(ev('({ a: 1, b: 2 })')).toEqual({ a: 1, b: 2 }))
  test('object shorthand', () =>
    expect(ev('({ x, y })', { x: 10, y: 20 })).toEqual({ x: 10, y: 20 }))
  test('object computed key', () =>
    expect(ev('({ [key]: 99 })', { key: 'dynamic' })).toEqual({ dynamic: 99 }))
  test('object spread', () =>
    expect(ev('({ ...base, c: 3 })', { base: { a: 1, b: 2 } })).toEqual({ a: 1, b: 2, c: 3 }))

  // ── typeof / void ─────────────────────────────────────────────────
  test('typeof number', () => expect(ev('typeof 42')).toBe('number'))
  test('typeof string', () => expect(ev('typeof "hi"')).toBe('string'))
  test('typeof undefined identifier', () => expect(ev('typeof nope')).toBe('undefined'))
  test('void 0', () => expect(ev('void 0')).toBe(undefined))

  // ── Pipeline operator |> ──────────────────────────────────────────
  test('pipeline basic', () =>
    expect(ev('5 |> double(%)', { double: (x: number) => x * 2 }, ALLOW_ALL_CALLS)).toBe(10))
  test('pipeline chained', () =>
    expect(
      ev('5 |> double(%) |> double(%)', { double: (x: number) => x * 2 }, ALLOW_ALL_CALLS),
    ).toBe(20))
  test('pipeline topic can appear in arbitrary expression positions', () => {
    expect(
      ev('5 |> [%, % + 1, double(%)]', { double: (x: number) => x * 2 }, ALLOW_ALL_CALLS),
    ).toEqual([5, 6, 10])
  })
  test('pipeline creates nested topic scopes', () => {
    expect(
      ev('2 |> (% + 1 |> double(%)) + %', { double: (x: number) => x * 2 }, ALLOW_ALL_CALLS),
    ).toBe(8)
  })
  test('topic reference is rejected outside a pipeline body', () => {
    expect(() => parseExpression('% + 1')).toThrow('only allowed inside a pipeline body')
  })
  test('pipeline body must reference the topic', () => {
    expect(() => parseExpression('5 |> double')).toThrow("must reference '%' at least once")
  })
  test('conditional branches can contain hack pipes with assignment-level precedence', () => {
    expect(
      ev(
        'flag ? 1 : 2 |> double(%)',
        { flag: false, double: (x: number) => x * 2 },
        ALLOW_ALL_CALLS,
      ),
    ).toBe(4)
  })
  test('pipeline body rejects unparenthesized conditional expressions', () => {
    expect(() => parseExpression('5 |> flag ? % : 0')).toThrow(
      'Hack pipe body cannot be an unparenthesized conditional expression',
    )
  })
  test('modulo operator remains available outside topic position', () => {
    expect(ev('20 % 6')).toBe(2)
  })

  // ── Arrow functions ──────────────────────────────────────────────
  test('simple concise arrow can be created and called', () => {
    expect(ev('(x => x + 1)(2)')).toBe(3)
  })
  test('empty-parameter arrow works', () => {
    expect(ev('(() => 1)()')).toBe(1)
  })
  test('arrow default parameters evaluate left to right', () => {
    expect(ev('((x, y = x + 1) => y)(2)')).toBe(3)
  })
  test('arrow default parameters preserve TDZ-like self references', () => {
    expect(() => ev('((x = x) => x)()')).toThrow('before initialization')
  })
  test('arrow rest parameters collect trailing arguments', () => {
    expect(ev('((head, ...rest) => rest[1])(1, 2, 3, 4)')).toBe(3)
  })
  test('arrow array destructuring works', () => {
    expect(ev('(([first, ...rest]) => rest[0])([1, 2, 3])')).toBe(2)
  })
  test('arrow object destructuring with defaults and rest works', () => {
    expect(
      ev(
        "(({ name, count = 1, ...rest }) => `${name}:${count}:${rest.extra}`)({ name: 'Ada', extra: 4 })",
      ),
    ).toBe('Ada:1:4')
  })
  test('arrow closures capture outer scope', () => {
    expect(ev('((x) => (() => x + bonus))(2)()', { bonus: 3 })).toBe(5)
  })
  test('arrow closures capture outer pipe topics', () => {
    expect(ev('2 |> (() => % + 1)()')).toBe(3)
  })
  test('allowCalls=false blocks arrow invocation', () => {
    expect(() => ev('(x => x)(1)', {}, { allowCalls: false })).toThrow('not enabled')
  })
  test('arrow functions can be disabled explicitly', () => {
    expect(() => parseExpression('x => x', { allowArrowFunctions: false })).toThrow(
      'Arrow functions are not enabled',
    )
  })
  test('arrow functions reject lexical this-like references', () => {
    expect(() => parseExpression('() => this')).toThrow("do not support 'this'")
    expect(() => parseExpression('() => arguments')).toThrow("do not support 'arguments'")
  })
  test('arrow functions reject block bodies', () => {
    expect(() => parseExpression('x => { value: x }')).toThrow('block bodies are not supported')
  })
  test('performance function mode supports default and rest parameters', () => {
    expect(
      ev(
        '((x, y = x + bonus, ...rest) => y + rest.length)(2, undefined, 1, 2)',
        { bonus: 3 },
        { functionMode: 'performance' },
      ),
    ).toBe(7)
  })
  test('performance function mode preserves destructuring and topic capture', () => {
    expect(
      ev(
        '2 |> ((({ value, count = 1, ...rest }) => value + % + count + rest.extra)({ value: 3, extra: 4 }))',
        {},
        { functionMode: 'performance' },
      ),
    ).toBe(10)
  })

  // ── in operator ───────────────────────────────────────────────────
  test('in operator', () =>
    expect(ev('"x" in obj', { obj: { x: 1 } }, { allowIn: true })).toBe(true))
  test('in operator: missing key', () =>
    expect(ev('"y" in obj', { obj: { x: 1 } }, { allowIn: true })).toBe(false))
  test('in operator throws for primitive right-hand sides', () => {
    expect(() => ev('"x" in value', { value: 1 }, { allowIn: true })).toThrow(TypeError)
  })
  test('in operator accepts functions on the right-hand side', () => {
    expect(ev('"apply" in fn', { fn: () => undefined }, { allowIn: true })).toBe(true)
  })
  test('instanceof operator', () =>
    expect(ev('arr instanceof Array', { arr: [1, 2], Array })).toBe(true))

  // ── Comma / sequence ─────────────────────────────────────────────
  test('sequence operator returns the last expression result', () => {
    expect(ev('1, 2, 3')).toBe(3)
  })
  test('sequence operator evaluates expressions from left to right', () => {
    const seen: number[] = []

    expect(
      ev(
        'push(1), push(2), push(3)',
        {
          push(value: number) {
            seen.push(value)
            return value
          },
        },
        ALLOW_ALL_CALLS,
      ),
    ).toBe(3)
    expect(seen).toEqual([1, 2, 3])
  })
  test('parseExpression emits sequence nodes for comma expressions', () => {
    const parsed = parseExpression('1, 2, 3')

    expect(parsed.type).toBe('sequence')
    if (parsed.type !== 'sequence') throw new Error('Expected a sequence node')
    expect(parsed.expressions).toHaveLength(3)
  })

  // ── Security / sandbox ───────────────────────────────────────────
  test('blocked global: eval', () => expect(() => ev('eval("1+1")')).toThrow('not permitted'))
  test('blocked global: Function', () =>
    expect(() => ev('Function("return 1")')).toThrow('not permitted'))
  test('blocked global: process', () => expect(() => ev('process.env')).toThrow('not permitted'))
  test('blocked global: globalThis', () => expect(() => ev('globalThis')).toThrow('not permitted'))
  test('blocked property: __proto__', () =>
    expect(() => ev('obj.__proto__', { obj: {} })).toThrow('not permitted'))
  test('blocked property: constructor', () =>
    expect(() => ev('obj.constructor', { obj: {} })).toThrow('not permitted'))
  test('blocked property via computed access', () =>
    expect(() => ev('obj["__proto__"]', { obj: {} })).toThrow('not permitted'))
  test('default call policy blocks custom function calls', () => {
    expect(() => ev('double(5)', { double: (x: number) => x * 2 })).toThrow('not permitted')
  })
  test('calls can be disabled entirely with allowCalls=false', () => {
    expect(() => ev('Math.max(1, 2)', { Math }, { allowCalls: false })).toThrow('not enabled')
  })
  test('regex literals can be disabled with allowRegexLiterals=false', () => {
    expect(() => ev('/abc/', {}, { allowRegexLiterals: false })).toThrow('not enabled')
  })
  test('default root context mode rejects non-plain objects', () => {
    class Scope {
      count = 2
    }

    expect(() => evaluate('count', new Scope() as unknown as Record<string, unknown>)).toThrow(
      'plain object',
    )
  })
  test('copy-non-plain root context mode preserves own properties only', () => {
    class Scope {
      count = 2
    }
    ;(Scope.prototype as unknown as Record<string, unknown>).hidden = 99

    expect(
      evaluate('count', new Scope() as unknown as Record<string, unknown>, {
        rootContextMode: 'copy-non-plain-to-null-prototype',
      }),
    ).toBe(2)
    expect(() =>
      evaluate('hidden', new Scope() as unknown as Record<string, unknown>, {
        rootContextMode: 'copy-non-plain-to-null-prototype',
      }),
    ).toThrow('not defined')
  })
  test('copy-plain-data-to-null-prototype rejects accessor properties without invoking getters', () => {
    let getterHits = 0
    const nested = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        getterHits += 1
        return 2
      },
    })

    expect(() =>
      evaluate('nested.value', { nested } as Record<string, unknown>, {
        rootContextMode: 'copy-plain-data-to-null-prototype',
      }),
    ).toThrow('accessor properties')
    expect(getterHits).toBe(0)
  })
  test('copy-plain-data-to-null-prototype rejects circular references', () => {
    const context = { value: 1 } as Record<string, unknown>
    context.self = context

    expect(() =>
      evaluate('value', context, {
        rootContextMode: 'copy-plain-data-to-null-prototype',
      }),
    ).toThrow('circular references')
  })
  test('copy-plain-data-to-null-prototype supports nested plain data graphs', () => {
    expect(
      evaluate(
        'nested.value + items[0]',
        {
          nested: { value: 4 },
          items: [3, 2, 1],
        },
        {
          rootContextMode: 'copy-plain-data-to-null-prototype',
        },
      ),
    ).toBe(7)
  })
  test('default object spread mode filters blocked keys', () => {
    const payload = JSON.parse('{"__proto__":{"polluted":true},"ok":1}') as Record<string, unknown>
    const result = ev('({ ...payload })', { payload }) as Record<string, unknown>

    expect(result.ok).toBe(1)
    expect(Object.getPrototypeOf(result)).not.toHaveProperty('polluted')
  })
  test('object spread mode none keeps legacy spread behavior', () => {
    const payload = JSON.parse('{"__proto__":{"polluted":true},"ok":1}') as Record<string, unknown>
    const result = ev('({ ...payload })', { payload }, { objectLiteralMode: 'none' }) as Record<
      string,
      unknown
    >

    expect(Object.getPrototypeOf(result)).toHaveProperty('polluted', true)
  })
  test('object spread plain-object-only mode rejects arrays', () => {
    expect(() =>
      ev('({ ...items })', { items: [1, 2, 3] }, { objectLiteralMode: 'plain-object-only' }),
    ).toThrow('plain object')
  })
  test('object spread safe mode returns null-prototype objects', () => {
    const result = ev('({ a: 1 })', {}, { objectLiteralMode: 'safe' }) as Record<string, unknown>

    expect(Object.getPrototypeOf(result)).toBe(null)
    expect(result.a).toBe(1)
  })
  test('max source length rejects oversized expressions', () => {
    expect(() => parseExpression('count + 1', { maxSourceLength: 5 })).toThrow(
      'maximum source length',
    )
  })
  test('max AST nodes rejects oversized trees', () => {
    expect(() => parseExpression('1 + 2 * 3', { maxAstNodes: 4 })).toThrow('maximum AST node count')
  })
  test('max AST depth rejects deep trees', () => {
    expect(() => parseExpression('a + (b * (c - d))', { maxAstDepth: 3 })).toThrow(
      'maximum AST depth',
    )
  })
  test('max steps rejects expensive evaluations', () => {
    expect(() => ev('1 + 2 + 3', {}, { maxSteps: 4 })).toThrow('Maximum evaluation steps')
  })
  test('max steps counts spread elements in array literals', () => {
    expect(() => ev('[...items]', { items: [1, 2, 3] }, { maxSteps: 5 })).toThrow(
      'Maximum evaluation steps',
    )
  })
  test('max steps counts spread elements in call arguments', () => {
    expect(() =>
      ev(
        'collect(...items)',
        {
          items: [1, 2, 3],
          collect: (...values: number[]) => values.length,
        },
        {
          ...ALLOW_ALL_CALLS,
          maxSteps: 5,
        },
      ),
    ).toThrow('Maximum evaluation steps')
  })
  test('undefined variable throws JSEvalError', () =>
    expect(() => ev('notDefined')).toThrow('not defined'))
  test('member of null throws descriptively', () =>
    expect(() => ev('x.y', { x: null })).toThrow('null'))
  test('non-function call throws descriptively', () =>
    expect(() => ev('x()', { x: 42 })).toThrow('not a function'))

  // ── Error position info ───────────────────────────────────────────
  test('parse error reports position', () => {
    let error: JSParseError | undefined
    try {
      evaluate('1 + * 2')
    } catch (e) {
      error = e as JSParseError
    }
    if (!error || !(error instanceof JSParseError)) throw new Error('Expected JSParseError')
    if (error.start === undefined || error.start < 0)
      throw new Error(`Expected start position, got: ${error.start}`)
  })
  test('parse error message contains source snippet', () => {
    let error: JSParseError | undefined
    try {
      evaluate('foo + * bar')
    } catch (e) {
      error = e as JSParseError
    }
    if (!error?.message.includes('foo + * bar'))
      throw new Error(`Expected snippet in error message, got: ${error?.message}`)
  })
  test('lex error reports position', () => {
    let error: JSLexError | undefined
    try {
      evaluate('1 + @bad')
    } catch (e) {
      error = e as JSLexError
    }
    if (!error || !(error instanceof JSLexError)) throw new Error('Expected JSLexError')
    if (typeof error.pos !== 'number') throw new Error('Expected pos property')
  })
  test('eval error reports meaningful message for chained access', () => {
    let error: JSEvalError | undefined
    try {
      evaluate('a.b.c', { a: {} })
    } catch (e) {
      error = e as JSEvalError
    }
    if (!error?.message.includes('undefined'))
      throw new Error(`Expected mention of 'undefined', got: ${error?.message}`)
  })
  test('unterminated string lex error', () =>
    expect(() => evaluate('"unterminated')).toThrow('position'))
  test('unexpected token parse error points to the bad token', () => {
    let error: JSParseError | undefined
    try {
      evaluate('1 2')
    } catch (e) {
      // two adjacent expressions
      error = e as JSParseError
    }
    if (!error || !(error instanceof JSParseError)) throw new Error('Expected JSParseError')
    // The position should point at the '2', which starts at offset 2
    if (error.start !== 2) throw new Error(`Expected start=2, got ${error.start}`)
  })

  // ── Forbidden constructs ──────────────────────────────────────────
  test('assignment throws ParseError', () =>
    expect(() => evaluate('x = 1', { x: 1 })).toThrow('not allowed'))
  test('compound assignment throws ParseError', () =>
    expect(() => evaluate('x += 1', { x: 1 })).toThrow('not allowed'))
  test('new keyword throws ParseError', () =>
    expect(() => evaluate('new Date()')).toThrow("'new' is not allowed"))
  test('delete keyword throws ParseError', () =>
    expect(() => evaluate('delete obj.x', { obj: { x: 1 } })).toThrow("'delete' is not allowed"))
  test('prefix ++ throws ParseError', () =>
    expect(() => evaluate('++x', { x: 1 })).toThrow('not allowed'))
  test('await without option throws ParseError', () =>
    expect(() => evaluate('await p', { p: Promise.resolve(1) })).toThrow('not enabled'))
  test('await with option works', () => {
    // In sync mode, await just passes through the value
    const result = evaluate('await 42', {}, { allowAwait: true })
    expect(result).toBe(42)
  })

  // ── Complex real-world template-style expressions ─────────────────
  test('conditional rendering idiom', () =>
    expect(
      ev(
        'items.length > 0 ? items.join(", ") : "none"',
        { items: ['a', 'b', 'c'] },
        ALLOW_ALL_CALLS,
      ),
    ).toBe('a, b, c'))
  test('safe navigation with fallback', () =>
    expect(ev('user?.profile?.bio ?? "No bio"', { user: { profile: null } })).toBe('No bio'))
  test('array map and join', () =>
    expect(
      ev(
        'items.map(fn).join(" | ")',
        {
          items: [1, 2, 3],
          fn: (x: number) => x * x,
        },
        ALLOW_ALL_CALLS,
      ),
    ).toBe('1 | 4 | 9'))
  test('object property access and formatting', () =>
    expect(
      ev('`${user.firstName} ${user.lastName} (${user.age})`', {
        user: { firstName: 'Jane', lastName: 'Doe', age: 30 },
      }),
    ).toBe('Jane Doe (30)'))
  test('pipeline for data transformation', () =>
    expect(
      ev(
        '"  hello  " |> trim(%) |> upper(%)',
        {
          trim: (s: string) => s.trim(),
          upper: (s: string) => s.toUpperCase(),
        },
        ALLOW_ALL_CALLS,
      ),
    ).toBe('HELLO'))
  test('numeric separator in source', () => expect(ev('1_000_000 + 234_567')).toBe(1234567))
})

// #endregion
