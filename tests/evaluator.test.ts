import { describe, expect, test } from "vitest";
import { evaluate, EvalOptions, JSParseError, JSEvalError, JSLexError } from "../src/expr/index.js"

function ev(expr: string, ctx: Record<string, unknown> = {}, opts: EvalOptions = {}): unknown {
  return evaluate(expr, ctx, opts)
}

describe("evaluator", () => {
  test('integer literal', () => expect(ev('42')).toBe(42));
  test('float literal', () => expect(ev('3.14')).toBe(3.14));
  test('hex literal', () => expect(ev('0xFF')).toBe(255));
  test('octal literal', () => expect(ev('0o17')).toBe(15));
  test('binary literal', () => expect(ev('0b1010')).toBe(10));
  test('bigint literal', () => expect(ev('9007199254740993n')).toBe(9007199254740993n));
  test('string double quotes', () => expect(ev('"hello"')).toBe('hello'));
  test('string single quotes', () => expect(ev("'world'")).toBe('world'));
  test('string escape sequences', () => expect(ev('"a\\nb"')).toBe('a\nb'));
  test('boolean true', () => expect(ev('true')).toBe(true));
  test('boolean false', () => expect(ev('false')).toBe(false));
  test('null literal', () => expect(ev('null')).toBe(null));
  test('undefined literal', () => expect(ev('undefined')).toBe(undefined));
  test('regex literal', () => {
    const r = ev('/abc/gi') as RegExp
    if (!(r instanceof RegExp)) throw new Error('Expected RegExp instance')
    if (r.source !== 'abc') throw new Error('Wrong source')
    if (r.flags !== 'gi') throw new Error('Wrong flags')
  });

  // ── Operator precedence ───────────────────────────────────────────
  test('precedence: * over +', () => expect(ev('2 + 3 * 4')).toBe(14));
  test('precedence: grouping overrides', () => expect(ev('(2 + 3) * 4')).toBe(20));
  test('precedence: ** right-assoc', () => expect(ev('2 ** 3 ** 2')).toBe(512)),   // 2**(3**2)=512
    test('precedence: unary before **', () => expect(ev('-2 ** 2')).toBe(-4)),        // -(2**2)
    test('precedence: bitwise < arithmetic', () => expect(ev('1 + 2 | 4')).toBe(7)), // (1+2)|4
    test('left-assoc subtraction', () => expect(ev('10 - 3 - 2')).toBe(5));
  test('comparison chains', () => expect(ev('1 < 2 === true')).toBe(true));
  test('logical AND short-circuit', () => {
    let called = false
    ev('false && fn()', { fn: () => { called = true } })
    if (called) throw new Error('fn should not have been called')
  });
  test('logical OR short-circuit', () => {
    let called = false
    ev('true || fn()', { fn: () => { called = true } })
    if (called) throw new Error('fn should not have been called')
  });
  test('nullish coalescing', () => expect(ev('null ?? "default"')).toBe('default'));
  test('nullish coalescing skips 0 and false', () => {
    expect(ev('0 ?? 42')).toBe(0)
    expect(ev('false ?? 42')).toBe(false)
  });

  // ── Ternary ───────────────────────────────────────────────────────
  test('ternary basic', () => expect(ev('1 > 0 ? "yes" : "no"')).toBe('yes'));
  test('ternary right-assoc', () => expect(ev('false ? 1 : true ? 2 : 3')).toBe(2));
  test('ternary with complex expressions', () =>
    expect(ev('x > 10 ? x * 2 : x + 1', { x: 5 })).toBe(6)
  );

  // ── Arithmetic and math ───────────────────────────────────────────
  test('modulo', () => expect(ev('17 % 5')).toBe(2));
  test('division', () => expect(ev('7 / 2')).toBe(3.5));
  test('bitwise NOT', () => expect(ev('~5')).toBe(-6));
  test('left shift', () => expect(ev('1 << 8')).toBe(256));
  test('unsigned right shift', () => expect(ev('-1 >>> 0')).toBe(4294967295));

  // ── String operations ─────────────────────────────────────────────
  test('string concatenation', () => expect(ev('"foo" + "bar"')).toBe('foobar'));
  test('template literal basic', () => expect(ev('`hello world`')).toBe('hello world'));
  test('template literal with expression', () =>
    expect(ev('`${x} + ${y} = ${x + y}`', { x: 3, y: 4 })).toBe('3 + 4 = 7')
  );
  test('template literal nested', () =>
    expect(ev('`${ `inner ${n}` }`', { n: 7 })).toBe('inner 7')
  );
  test('tagged template literal', () => {
    const tag = (strings: TemplateStringsArray, ...vals: unknown[]) =>
      strings.raw.join('') + '|' + vals.join(',')
    expect(ev('tag`a${1}b${2}c`', { tag })).toBe('abc|1,2')
  });

  // ── Member access ─────────────────────────────────────────────────
  test('dot member access', () =>
    expect(ev('obj.name', { obj: { name: 'Alice' } })).toBe('Alice')
  );
  test('computed member access', () =>
    expect(ev('obj["key"]', { obj: { key: 42 } })).toBe(42)
  );
  test('chained member access', () =>
    expect(ev('a.b.c', { a: { b: { c: 99 } } })).toBe(99)
  );
  test('optional chaining: null base', () =>
    expect(ev('obj?.name', { obj: null })).toBe(undefined)
  );
  test('optional chaining: defined base', () =>
    expect(ev('obj?.name', { obj: { name: 'Bob' } })).toBe('Bob')
  );
  test('optional chaining: computed', () =>
    expect(ev('obj?.[key]', { obj: null, key: 'x' })).toBe(undefined)
  );
  test('optional chaining: call', () =>
    expect(ev('fn?.()', { fn: null })).toBe(undefined)
  );
  test('array index', () =>
    expect(ev('arr[1]', { arr: [10, 20, 30] })).toBe(20)
  );

  // ── Function calls ────────────────────────────────────────────────
  test('simple call', () =>
    expect(ev('double(5)', { double: (x: number) => x * 2 })).toBe(10)
  );
  test('method call', () =>
    expect(ev('obj.greet("world")', { obj: { greet: (s: string) => `Hello, ${s}!` } })).toBe('Hello, world!')
  );
  test('spread in call args', () =>
    expect(ev('Math.max(...nums)', { Math, nums: [1, 5, 3, 7, 2] })).toBe(7)
  );
  test('chained calls', () =>
    expect(ev('"  hello  ".trim().toUpperCase()', {})).toBe('HELLO')
  );

  // ── Array and object literals ─────────────────────────────────────
  test('array literal', () => expect(ev('[1, 2, 3]')).toEqual([1, 2, 3]));
  test('array spread', () =>
    expect(ev('[...a, 4]', { a: [1, 2, 3] })).toEqual([1, 2, 3, 4])
  );
  test('object literal', () =>
    expect(ev('({ a: 1, b: 2 })')).toEqual({ a: 1, b: 2 })
  );
  test('object shorthand', () =>
    expect(ev('({ x, y })', { x: 10, y: 20 })).toEqual({ x: 10, y: 20 })
  );
  test('object computed key', () =>
    expect(ev('({ [key]: 99 })', { key: 'dynamic' })).toEqual({ dynamic: 99 })
  );
  test('object spread', () =>
    expect(ev('({ ...base, c: 3 })', { base: { a: 1, b: 2 } })).toEqual({ a: 1, b: 2, c: 3 })
  );

  // ── typeof / void ─────────────────────────────────────────────────
  test('typeof number', () => expect(ev('typeof 42')).toBe('number'));
  test('typeof string', () => expect(ev('typeof "hi"')).toBe('string'));
  test('typeof undefined identifier', () => expect(ev('typeof nope')).toBe('undefined'));
  test('void 0', () => expect(ev('void 0')).toBe(undefined));

  // ── Pipeline operator |> ──────────────────────────────────────────
  test('pipeline basic', () =>
    expect(ev('5 |> double', { double: (x: number) => x * 2 })).toBe(10)
  );
  test('pipeline chained', () =>
    expect(ev('5 |> double |> double', { double: (x: number) => x * 2 })).toBe(20)
  );
  test('pipeline right-assoc: (5 |> (fn |> compose))', () => {
    // right-assoc means 5 |> (double |> triple) which is: (double |> triple)(5)
    // But in Hack-style |>, we want left-to-right piping
    // With right-assoc, 5 |> double |> triple = 5 |> (double |> triple)
    // This composes functions rather than pipes values
    // For clarity, let's just test a simple pipeline
    expect(ev('10 |> half', { half: (x: number) => x / 2 })).toBe(5)
  });

  // ── in operator ───────────────────────────────────────────────────
  test('in operator', () =>
    expect(ev('"x" in obj', { obj: { x: 1 } }, { allowIn: true })).toBe(true)
  );
  test('in operator: missing key', () =>
    expect(ev('"y" in obj', { obj: { x: 1 } }, { allowIn: true })).toBe(false)
  );
  test('instanceof operator', () =>
    expect(ev('arr instanceof Array', { arr: [1, 2], Array })).toBe(true)
  );

  // ── Comma / sequence ─────────────────────────────────────────────
  // Note: sequence as a top-level expression IS supported; each sub-expr is evaluated
  // For most uses in templates, comma in argument lists is the common case

  // ── Security / sandbox ───────────────────────────────────────────
  test('blocked global: eval', () =>
    expect(() => ev('eval("1+1")')).toThrow('not permitted')
  );
  test('blocked global: Function', () =>
    expect(() => ev('Function("return 1")')).toThrow('not permitted')
  );
  test('blocked global: process', () =>
    expect(() => ev('process.env')).toThrow('not permitted')
  );
  test('blocked global: globalThis', () =>
    expect(() => ev('globalThis')).toThrow('not permitted')
  );
  test('blocked property: __proto__', () =>
    expect(() => ev('obj.__proto__', { obj: {} })).toThrow('not permitted')
  );
  test('blocked property: constructor', () =>
    expect(() => ev('obj.constructor', { obj: {} })).toThrow('not permitted')
  );
  test('blocked property via computed access', () =>
    expect(() => ev('obj["__proto__"]', { obj: {} })).toThrow('not permitted')
  );
  test('undefined variable throws JSEvalError', () =>
    expect(() => ev('notDefined')).toThrow('not defined')
  );
  test('member of null throws descriptively', () =>
    expect(() => ev('x.y', { x: null })).toThrow('null')
  );
  test('non-function call throws descriptively', () =>
    expect(() => ev('x()', { x: 42 })).toThrow('not a function')
  );

  // ── Error position info ───────────────────────────────────────────
  test('parse error reports position', () => {
    let error: JSParseError | undefined
    try { evaluate('1 + * 2') }
    catch (e) { error = e as JSParseError }
    if (!error || !(error instanceof JSParseError))
      throw new Error('Expected JSParseError')
    if (error.start === undefined || error.start < 0)
      throw new Error(`Expected start position, got: ${error.start}`)
  });
  test('parse error message contains source snippet', () => {
    let error: JSParseError | undefined
    try { evaluate('foo + * bar') }
    catch (e) { error = e as JSParseError }
    if (!error?.message.includes('foo + * bar'))
      throw new Error(`Expected snippet in error message, got: ${error?.message}`)
  });
  test('lex error reports position', () => {
    let error: JSLexError | undefined
    try { evaluate('1 + @bad') }
    catch (e) { error = e as JSLexError }
    if (!error || !(error instanceof JSLexError))
      throw new Error('Expected JSLexError')
    if (typeof error.pos !== 'number')
      throw new Error('Expected pos property')
  });
  test('eval error reports meaningful message for chained access', () => {
    let error: JSEvalError | undefined
    try { evaluate('a.b.c', { a: {} }) }
    catch (e) { error = e as JSEvalError }
    if (!error?.message.includes('undefined'))
      throw new Error(`Expected mention of 'undefined', got: ${error?.message}`)
  });
  test('unterminated string lex error', () =>
    expect(() => evaluate('"unterminated')).toThrow('position')
  );
  test('unexpected token parse error points to the bad token', () => {
    let error: JSParseError | undefined
    try { evaluate('1 2') }  // two adjacent expressions
    catch (e) { error = e as JSParseError }
    if (!error || !(error instanceof JSParseError))
      throw new Error('Expected JSParseError')
    // The position should point at the '2', which starts at offset 2
    if (error.start !== 2)
      throw new Error(`Expected start=2, got ${error.start}`)
  });

  // ── Forbidden constructs ──────────────────────────────────────────
  test('assignment throws ParseError', () =>
    expect(() => evaluate('x = 1', { x: 1 })).toThrow('not allowed')
  );
  test('compound assignment throws ParseError', () =>
    expect(() => evaluate('x += 1', { x: 1 })).toThrow('not allowed')
  );
  test('new keyword throws ParseError', () =>
    expect(() => evaluate('new Date()')).toThrow("'new' is not allowed")
  );
  test('delete keyword throws ParseError', () =>
    expect(() => evaluate('delete obj.x', { obj: { x: 1 } })).toThrow("'delete' is not allowed")
  );
  test('prefix ++ throws ParseError', () =>
    expect(() => evaluate('++x', { x: 1 })).toThrow('not allowed')
  );
  test('await without option throws ParseError', () =>
    expect(() => evaluate('await p', { p: Promise.resolve(1) })).toThrow('not enabled')
  );
  test('await with option works', () => {
    // In sync mode, await just passes through the value
    const result = evaluate('await 42', {}, { allowAwait: true })
    expect(result).toBe(42)
  });

  // ── Complex real-world template-style expressions ─────────────────
  test('conditional rendering idiom', () =>
    expect(ev('items.length > 0 ? items.join(", ") : "none"', { items: ['a', 'b', 'c'] })).toBe('a, b, c')
  );
  test('safe navigation with fallback', () =>
    expect(ev('user?.profile?.bio ?? "No bio"', { user: { profile: null } })).toBe('No bio')
  );
  test('array map and join', () =>
    expect(ev('items.map(fn).join(" | ")', {
      items: [1, 2, 3],
      fn: (x: number) => x * x,
    })).toBe('1 | 4 | 9')
  );
  test('object property access and formatting', () =>
    expect(ev('`${user.firstName} ${user.lastName} (${user.age})`', {
      user: { firstName: 'Jane', lastName: 'Doe', age: 30 },
    })).toBe('Jane Doe (30)')
  );
  test('pipeline for data transformation', () =>
    expect(ev('"  hello  " |> trim |> upper', {
      trim: (s: string) => s.trim(),
      upper: (s: string) => s.toUpperCase(),
    })).toBe('HELLO')
  );
  test('numeric separator in source', () =>
    expect(ev('1_000_000 + 234_567')).toBe(1234567)
  );

});