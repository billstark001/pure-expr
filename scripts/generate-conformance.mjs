import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = resolve(ROOT, 'conformance/v1/corpus.json')
const CHECK_ONLY = process.argv.includes('--check')

const U = Object.freeze({ $conformance: 'undefined' })
const bigint = (value) => ({ $conformance: 'bigint', value })
const regex = (source, flags) => ({ $conformance: 'regex', source, flags })
const callable = (name, args = {}) => ({ $conformance: 'callable', name, ...args })
const builtin = (name) => ({ $conformance: 'builtin', name })
const special = (name, args = {}) => ({ $conformance: name, ...args })

const valueExpectation = (value) => ({ value })
const errorExpectation = (kind, messageIncludes, extra = {}) => ({
  error: {
    kind,
    messageIncludes: Array.isArray(messageIncludes) ? messageIncludes : [messageIncludes],
    ...extra,
  },
})
const matchExpectation = (match, paths = []) => ({ match, paths })

const evaluateCheck = (source, value, context = {}, options = {}, extra = {}) => ({
  op: 'evaluate',
  source,
  context,
  options,
  expect: valueExpectation(value),
  ...extra,
})
const evaluateErrorCheck = (
  source,
  kind,
  messageIncludes,
  context = {},
  options = {},
  extra = {},
) => ({
  op: 'evaluate',
  source,
  context,
  options,
  expect: errorExpectation(kind, messageIncludes),
  ...extra,
})
const parseCheck = (source, match, options = {}, paths = []) => ({
  op: 'parse-expression',
  source,
  options,
  expect: matchExpectation(match, paths),
})
const parseErrorCheck = (source, messageIncludes, options = {}, extra = {}) => ({
  op: 'parse-expression',
  source,
  options,
  expect: errorExpectation('parse', messageIncludes, extra),
})

const definitions = new Map()
const allDefinitions = []

function add(suite, name, checks, metadata = {}) {
  const key = `${suite}\u0000${name}`
  if (definitions.has(key)) throw new Error(`Duplicate conformance definition: ${suite} > ${name}`)
  const definition = {
    id: `${slug(suite)}.${slug(name)}`,
    sourceTest: { suite, name },
    profile: 'legacy-js-v1',
    checks: Array.isArray(checks) ? checks : [checks],
    ...metadata,
  }
  definitions.set(key, definition)
  allDefinitions.push(definition)
}

function ev(name, source, value, context = {}, options = {}, metadata = {}) {
  add('evaluator', name, evaluateCheck(source, value, context, options), metadata)
}

function evError(name, source, kind, message, context = {}, options = {}, metadata = {}) {
  add('evaluator', name, evaluateErrorCheck(source, kind, message, context, options), metadata)
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

// Expression literals and operators.
ev('integer literal', '42', 42)
ev('float literal', '3.14', 3.14)
ev('hex literal', '0xFF', 255)
ev('octal literal', '0o17', 15)
ev('binary literal', '0b1010', 10)
ev('bigint literal', '9007199254740993n', bigint('9007199254740993'))
ev('string double quotes', '"hello"', 'hello')
ev('string single quotes', "'world'", 'world')
ev('string escape sequences', '"a\\nb"', 'a\nb')
ev('boolean true', 'true', true)
ev('boolean false', 'false', false)
ev('null literal', 'null', null)
ev('undefined literal', 'undefined', U)
ev('regex literal', '/abc/gi', regex('abc', 'gi'))
ev('precedence: * over +', '2 + 3 * 4', 14)
ev('precedence: grouping overrides', '(2 + 3) * 4', 20)
ev('precedence: ** right-assoc', '2 ** 3 ** 2', 512)
ev('precedence: unary before **', '-2 ** 2', -4)
ev('precedence: bitwise < arithmetic', '1 + 2 | 4', 7)
ev('left-assoc subtraction', '10 - 3 - 2', 5)
ev('comparison chains', '1 < 2 === true', true)
ev('logical AND short-circuit', 'false && fn()', false, {
  fn: callable('fail-if-called'),
})
ev('logical OR short-circuit', 'true || fn()', true, {
  fn: callable('fail-if-called'),
})
ev('nullish coalescing', 'null ?? "default"', 'default')
add('evaluator', 'nullish coalescing skips 0 and false', [
  evaluateCheck('0 ?? 42', 0),
  evaluateCheck('false ?? 42', false),
])
add('evaluator', 'nullish coalescing rejects mixing with && or || without parentheses', [
  parseErrorCheck('1 ?? 2 || 3', 'without parentheses'),
  parseErrorCheck('1 && 2 ?? 3', 'without parentheses'),
])
add('evaluator', 'nullish coalescing allows grouped mixes with && or ||', [
  evaluateCheck('(1 ?? 2) || 3', 1),
  evaluateCheck('1 ?? (2 || 3)', 1),
])
ev('ternary basic', '1 > 0 ? "yes" : "no"', 'yes')
ev('ternary right-assoc', 'false ? 1 : true ? 2 : 3', 2)
ev('ternary with complex expressions', 'x > 10 ? x * 2 : x + 1', 6, { x: 5 })
ev('modulo', '17 % 5', 2)
ev('division', '7 / 2', 3.5)
ev('bitwise NOT', '~5', -6)
ev('left shift', '1 << 8', 256)
ev('unsigned right shift', '-1 >>> 0', 4294967295)
ev('string concatenation', '"foo" + "bar"', 'foobar')

// JavaScript template literals.
ev('template literal basic', '`hello world`', 'hello world')
ev('template literal with expression', '`${x} + ${y} = ${x + y}`', '3 + 4 = 7', {
  x: 3,
  y: 4,
})
ev('template literal nested', '`${ `inner ${n}` }`', 'inner 7', { n: 7 })
ev(
  'tagged template literal',
  'tag`a${1}b${2}c`',
  'abc|1,2',
  { tag: callable('tag-concat') },
  { callPolicy: 'allow-all' },
  { portability: 'host-callback' },
)
ev(
  'tagged template literal preserves method receivers',
  'obj.tag`x`',
  42,
  { obj: { value: 42, tag: callable('receiver-tag') } },
  { callPolicy: 'allow-all' },
  { portability: 'host-callback' },
)
evError(
  'template literal can be disabled',
  '`hello`',
  'parse',
  'not enabled',
  {},
  { allowTemplateLiterals: false },
)
evError(
  'tagged template literal can be disabled independently',
  'tag`hello`',
  'parse',
  'not enabled',
  { tag: callable('first-argument') },
  { allowTaggedTemplates: false },
)
add(
  'evaluator',
  'tagged template literal passes a cached spec-like template object by default',
  {
    op: 'compile-evaluate',
    source: 'tag`a\\nb${value}c`',
    options: { callPolicy: 'allow-all' },
    contexts: [
      { tag: callable('inspect-template'), value: 1 },
      { tag: callable('inspect-template'), value: 2 },
    ],
    observeTrace: true,
    expect: valueExpectation({
      values: [
        {
          cooked: 'a\nb',
          raw: 'a\\nb',
          frozen: true,
          rawFrozen: true,
          rawEnumerable: false,
        },
        {
          cooked: 'a\nb',
          raw: 'a\\nb',
          frozen: true,
          rawFrozen: true,
          rawEnumerable: false,
        },
      ],
      trace: [
        { event: 'template-object', sameAsFirst: null },
        { event: 'template-object', sameAsFirst: true },
      ],
    }),
  },
  { portability: 'js-template-object' },
)
add(
  'evaluator',
  'compiled expressions do not leak nested evaluation context',
  {
    op: 'compiled-nested-evaluate',
    source: 'fn(value) + value',
    options: { callPolicy: 'allow-all' },
    expect: valueExpectation(7),
  },
  { portability: 'host-callback' },
)
ev(
  'tagged template literal supports loose array emulation mode',
  'tag`x`',
  { frozen: false, rawFrozen: false, rawEnumerable: true },
  { tag: callable('inspect-template-flags') },
  { callPolicy: 'allow-all', taggedTemplateArrayMode: 'loose' },
  { portability: 'js-template-object' },
)
evError(
  'untagged template literal rejects invalid escapes',
  '`bad \\u{110000}`',
  'parse',
  'Invalid escape sequence',
)
ev(
  'tagged template literal preserves raw text and undefined cooked values for invalid escapes',
  'tag`bad \\u{110000}`',
  [U, 'bad \\u{110000}'],
  { tag: callable('template-first-and-raw') },
  { callPolicy: 'allow-all' },
  { portability: 'js-template-object' },
)
ev(
  'template placeholder expressions handle regex literals, comments, and nested braces',
  '`${ /* keep */ /a{2}/.test(text) ? `{${value}}` : "no" }`',
  '{x}',
  { text: 'aa', value: 'x' },
  { callPolicy: 'allow-all' },
)

// Member access and calls.
ev('dot member access', 'obj.name', 'Alice', { obj: { name: 'Alice' } })
ev('computed member access', 'obj["key"]', 42, { obj: { key: 42 } })
ev('chained member access', 'a.b.c', 99, { a: { b: { c: 99 } } })
ev('optional chaining: null base', 'obj?.name', U, { obj: null })
ev('optional chaining: defined base', 'obj?.name', 'Bob', { obj: { name: 'Bob' } })
ev('optional chaining: computed', 'obj?.[key]', U, { obj: null, key: 'x' })
ev('optional chaining: call', 'fn?.()', U, { fn: null })
ev('array index', 'arr[1]', 20, { arr: [10, 20, 30] })
ev(
  'simple call',
  'double(5)',
  10,
  { double: callable('multiply', { factor: 2 }) },
  { callPolicy: 'allow-all' },
  { portability: 'host-callback' },
)
ev(
  'method call',
  'obj.greet("world")',
  'Hello, world!',
  { obj: { greet: callable('greet') } },
  { callPolicy: 'allow-all' },
  { portability: 'host-callback' },
)
ev('spread in call args', 'Math.max(...nums)', 7, {
  Math: builtin('Math'),
  nums: [1, 5, 3, 7, 2],
})
ev('chained calls', '"  hello  ".trim().toUpperCase()', 'HELLO')
add('evaluator', 'default call policy allows newer safe string methods', [
  evaluateCheck('"A\u030A".normalize("NFC")', 'Å'),
  evaluateCheck('"😊".codePointAt(0)', 0x1f60a),
])
ev('default call policy allows newer safe array methods', '[1, [2, [3]]].flat(2)', [1, 2, 3])

// Collections, unary forms, pipelines, and arrows.
ev('array literal', '[1, 2, 3]', [1, 2, 3])
ev('array spread', '[...a, 4]', [1, 2, 3, 4], { a: [1, 2, 3] })
ev('object literal', '({ a: 1, b: 2 })', { a: 1, b: 2 })
ev('object shorthand', '({ x, y })', { x: 10, y: 20 }, { x: 10, y: 20 })
ev('object computed key', '({ [key]: 99 })', { dynamic: 99 }, { key: 'dynamic' })
ev('object spread', '({ ...base, c: 3 })', { a: 1, b: 2, c: 3 }, { base: { a: 1, b: 2 } })
ev('typeof number', 'typeof 42', 'number')
ev('typeof string', 'typeof "hi"', 'string')
ev('typeof undefined identifier', 'typeof nope', 'undefined')
ev('void 0', 'void 0', U)
ev(
  'pipeline basic',
  '5 |> double(%)',
  10,
  { double: callable('multiply', { factor: 2 }) },
  { callPolicy: 'allow-all' },
)
ev(
  'pipeline chained',
  '5 |> double(%) |> double(%)',
  20,
  { double: callable('multiply', { factor: 2 }) },
  { callPolicy: 'allow-all' },
)
ev(
  'pipeline topic can appear in arbitrary expression positions',
  '5 |> [%, % + 1, double(%)]',
  [5, 6, 10],
  { double: callable('multiply', { factor: 2 }) },
  { callPolicy: 'allow-all' },
)
ev(
  'pipeline creates nested topic scopes',
  '2 |> (% + 1 |> double(%)) + %',
  8,
  { double: callable('multiply', { factor: 2 }) },
  { callPolicy: 'allow-all' },
)
add(
  'evaluator',
  'topic reference is rejected outside a pipeline body',
  parseErrorCheck('% + 1', 'only allowed inside a pipeline body'),
)
add(
  'evaluator',
  'pipeline body must reference the topic',
  parseErrorCheck('5 |> double', "must reference '%' at least once"),
)
ev(
  'conditional branches can contain hack pipes with assignment-level precedence',
  'flag ? 1 : 2 |> double(%)',
  4,
  { flag: false, double: callable('multiply', { factor: 2 }) },
  { callPolicy: 'allow-all' },
)
add(
  'evaluator',
  'pipeline body rejects unparenthesized conditional expressions',
  parseErrorCheck(
    '5 |> flag ? % : 0',
    'Hack pipe body cannot be an unparenthesized conditional expression',
  ),
)
ev('modulo operator remains available outside topic position', '20 % 6', 2)
ev('simple concise arrow can be created and called', '(x => x + 1)(2)', 3)
ev('empty-parameter arrow works', '(() => 1)()', 1)
ev('arrow default parameters evaluate left to right', '((x, y = x + 1) => y)(2)', 3)
evError(
  'arrow default parameters preserve TDZ-like self references',
  '((x = x) => x)()',
  'eval',
  'before initialization',
)
ev(
  'arrow rest parameters collect trailing arguments',
  '((head, ...rest) => rest[1])(1, 2, 3, 4)',
  3,
)
ev('arrow array destructuring works', '(([first, ...rest]) => rest[0])([1, 2, 3])', 2)
ev(
  'arrow object destructuring with defaults and rest works',
  "(({ name, count = 1, ...rest }) => `${name}:${count}:${rest.extra}`)({ name: 'Ada', extra: 4 })",
  'Ada:1:4',
)
ev('arrow closures capture outer scope', '((x) => (() => x + bonus))(2)()', 5, { bonus: 3 })
ev('arrow closures capture outer pipe topics', '2 |> (() => % + 1)()', 3)
evError(
  'allowCalls=false blocks arrow invocation',
  '(x => x)(1)',
  'eval',
  'not enabled',
  {},
  { allowCalls: false },
)
add(
  'evaluator',
  'arrow functions can be disabled explicitly',
  parseErrorCheck('x => x', 'Arrow functions are not enabled', { allowArrowFunctions: false }),
)
add('evaluator', 'arrow functions reject lexical this-like references', [
  parseErrorCheck('() => this', "do not support 'this'"),
  parseErrorCheck('() => arguments', "do not support 'arguments'"),
])
add(
  'evaluator',
  'arrow functions reject block bodies',
  parseErrorCheck('x => { value: x }', 'block bodies are not supported'),
)
ev(
  'performance function mode supports default and rest parameters',
  '((x, y = x + bonus, ...rest) => y + rest.length)(2, undefined, 1, 2)',
  7,
  { bonus: 3 },
  { functionMode: 'performance' },
)
ev(
  'performance function mode preserves destructuring and topic capture',
  '2 |> ((({ value, count = 1, ...rest }) => value + % + count + rest.extra)({ value: 3, extra: 4 }))',
  10,
  {},
  { functionMode: 'performance' },
)

// JS-specific operators and ordered evaluation.
ev('in operator', '"x" in obj', true, { obj: { x: 1 } }, { allowIn: true })
ev('in operator: missing key', '"y" in obj', false, { obj: { x: 1 } }, { allowIn: true })
evError(
  'in operator throws for primitive right-hand sides',
  '"x" in value',
  'host',
  '',
  { value: 1 },
  { allowIn: true },
)
ev(
  'in operator accepts functions on the right-hand side',
  '"apply" in fn',
  true,
  { fn: callable('no-op') },
  { allowIn: true },
  { portability: 'js-prototype-chain' },
)
ev(
  'instanceof operator',
  'arr instanceof Array',
  true,
  { arr: [1, 2], Array: builtin('Array') },
  {},
  { portability: 'js-prototype-chain' },
)
ev('sequence operator returns the last expression result', '1, 2, 3', 3)
add(
  'evaluator',
  'sequence operator evaluates expressions from left to right',
  {
    ...evaluateCheck(
      'push(1), push(2), push(3)',
      { value: 3, trace: [1, 2, 3] },
      { push: callable('record-argument') },
      { callPolicy: 'allow-all' },
    ),
    observeTrace: true,
  },
  { portability: 'host-callback' },
)
add(
  'evaluator',
  'parseExpression emits sequence nodes for comma expressions',
  parseCheck('1, 2, 3', { type: 'sequence' }, [{ path: '/expressions/length', equals: 3 }]),
)

// Security, budgets, and errors.
evError('blocked global: eval', 'eval("1+1")', 'eval', 'not permitted')
evError('blocked global: Function', 'Function("return 1")', 'eval', 'not permitted')
evError('blocked global: process', 'process.env', 'eval', 'not permitted')
evError('blocked global: globalThis', 'globalThis', 'eval', 'not permitted')
evError('blocked property: __proto__', 'obj.__proto__', 'eval', 'not permitted', { obj: {} })
evError('blocked property: constructor', 'obj.constructor', 'eval', 'not permitted', { obj: {} })
evError('blocked property via computed access', 'obj["__proto__"]', 'eval', 'not permitted', {
  obj: {},
})
evError('default call policy blocks custom function calls', 'double(5)', 'eval', 'not permitted', {
  double: callable('multiply', { factor: 2 }),
})
evError(
  'calls can be disabled entirely with allowCalls=false',
  'Math.max(1, 2)',
  'eval',
  'not enabled',
  { Math: builtin('Math') },
  { allowCalls: false },
)
evError(
  'regex literals can be disabled with allowRegexLiterals=false',
  '/abc/',
  'parse',
  'not enabled',
  {},
  { allowRegexLiterals: false },
)
evError(
  'default root context mode rejects non-plain objects',
  'count',
  'eval',
  'plain object',
  special('class-instance', { own: { count: 2 } }),
  {},
  { portability: 'js-object-model' },
)
add(
  'evaluator',
  'copy-non-plain root context mode preserves own properties only',
  [
    evaluateCheck(
      'count',
      2,
      special('class-instance', { own: { count: 2 }, prototype: { hidden: 99 } }),
      { rootContextMode: 'copy-non-plain-to-null-prototype' },
    ),
    evaluateErrorCheck(
      'hidden',
      'eval',
      'not defined',
      special('class-instance', { own: { count: 2 }, prototype: { hidden: 99 } }),
      { rootContextMode: 'copy-non-plain-to-null-prototype' },
    ),
  ],
  { portability: 'js-object-model' },
)
add(
  'evaluator',
  'copy-plain-data-to-null-prototype rejects accessor properties without invoking getters',
  {
    op: 'evaluate',
    source: 'nested.value',
    context: { nested: special('accessor-object', { property: 'value', value: 2 }) },
    options: { rootContextMode: 'copy-plain-data-to-null-prototype' },
    observeTrace: true,
    expect: {
      error: { kind: 'eval', messageIncludes: ['accessor properties'] },
      trace: [],
    },
  },
  { portability: 'js-object-model' },
)
evError(
  'copy-plain-data-to-null-prototype rejects circular references',
  'value',
  'eval',
  'circular references',
  special('circular-context', { value: 1 }),
  { rootContextMode: 'copy-plain-data-to-null-prototype' },
)
ev(
  'copy-plain-data-to-null-prototype supports nested plain data graphs',
  'nested.value + items[0]',
  7,
  { nested: { value: 4 }, items: [3, 2, 1] },
  { rootContextMode: 'copy-plain-data-to-null-prototype' },
)
add(
  'evaluator',
  'default object spread mode filters blocked keys',
  {
    ...evaluateCheck(
      '({ ...payload })',
      { value: { ok: 1 }, prototype: 'object', prototypeProperties: {} },
      { payload: special('json-object', { source: '{"__proto__":{"polluted":true},"ok":1}' }) },
    ),
    observePrototype: true,
  },
  { portability: 'js-object-model' },
)
add(
  'evaluator',
  'object spread mode none keeps legacy spread behavior',
  {
    ...evaluateCheck(
      '({ ...payload })',
      { value: { ok: 1 }, prototype: 'custom', prototypeProperties: { polluted: true } },
      { payload: special('json-object', { source: '{"__proto__":{"polluted":true},"ok":1}' }) },
      { objectLiteralMode: 'none' },
    ),
    observePrototype: true,
  },
  { portability: 'js-object-model' },
)
evError(
  'object spread plain-object-only mode rejects arrays',
  '({ ...items })',
  'eval',
  'plain object',
  { items: [1, 2, 3] },
  { objectLiteralMode: 'plain-object-only' },
)
add('evaluator', 'object spread safe mode returns null-prototype objects', {
  ...evaluateCheck(
    '({ a: 1 })',
    { value: { a: 1 }, prototype: 'null', prototypeProperties: {} },
    {},
    { objectLiteralMode: 'safe' },
  ),
  observePrototype: true,
})
add(
  'evaluator',
  'max source length rejects oversized expressions',
  parseErrorCheck('count + 1', 'maximum source length', { maxSourceLength: 5 }),
)
add(
  'evaluator',
  'max AST nodes rejects oversized trees',
  parseErrorCheck('1 + 2 * 3', 'maximum AST node count', { maxAstNodes: 4 }),
)
add(
  'evaluator',
  'max AST depth rejects deep trees',
  parseErrorCheck('a + (b * (c - d))', 'maximum AST depth', { maxAstDepth: 3 }),
)
evError(
  'max steps rejects expensive evaluations',
  '1 + 2 + 3',
  'eval',
  'Maximum evaluation steps',
  {},
  { maxSteps: 4 },
)
evError(
  'max steps counts spread elements in array literals',
  '[...items]',
  'eval',
  'Maximum evaluation steps',
  { items: [1, 2, 3] },
  { maxSteps: 5 },
)
evError(
  'max steps counts spread elements in call arguments',
  'collect(...items)',
  'eval',
  'Maximum evaluation steps',
  { items: [1, 2, 3], collect: callable('collect-count') },
  { callPolicy: 'allow-all', maxSteps: 5 },
)
evError('undefined variable throws JSEvalError', 'notDefined', 'eval', 'not defined')
evError('member of null throws descriptively', 'x.y', 'eval', 'null', { x: null })
evError('non-function call throws descriptively', 'x()', 'eval', 'not a function', { x: 42 })
add('evaluator', 'parse error reports position', {
  op: 'evaluate',
  source: '1 + * 2',
  context: {},
  options: {},
  expect: errorExpectation('parse', '', { startType: 'number' }),
})
add('evaluator', 'parse error message contains source snippet', {
  op: 'evaluate',
  source: 'foo + * bar',
  context: {},
  options: {},
  expect: errorExpectation('parse', 'foo + * bar'),
})
add('evaluator', 'lex error reports position', {
  op: 'evaluate',
  source: '1 + @bad',
  context: {},
  options: {},
  expect: errorExpectation('lex', '', { posType: 'number' }),
})
evError('eval error reports meaningful message for chained access', 'a.b.c', 'eval', 'undefined', {
  a: {},
})
evError('unterminated string lex error', '"unterminated', 'lex', 'position')
add('evaluator', 'unexpected token parse error points to the bad token', {
  op: 'evaluate',
  source: '1 2',
  context: {},
  options: {},
  expect: errorExpectation('parse', '', { start: 2 }),
})
evError('assignment throws ParseError', 'x = 1', 'parse', 'not allowed', { x: 1 })
evError('compound assignment throws ParseError', 'x += 1', 'parse', 'not allowed', { x: 1 })
evError('new keyword throws ParseError', 'new Date()', 'parse', "'new' is not allowed")
evError('delete keyword throws ParseError', 'delete obj.x', 'parse', "'delete' is not allowed", {
  obj: { x: 1 },
})
evError('prefix ++ throws ParseError', '++x', 'parse', 'not allowed', { x: 1 })
evError('await without option throws ParseError', 'await p', 'parse', 'not enabled', { p: null })
ev('await with option works', 'await 42', 42, {}, { allowAwait: true })

// Representative configuration expressions.
ev(
  'conditional rendering idiom',
  'items.length > 0 ? items.join(", ") : "none"',
  'a, b, c',
  { items: ['a', 'b', 'c'] },
  { callPolicy: 'allow-all' },
)
ev('safe navigation with fallback', 'user?.profile?.bio ?? "No bio"', 'No bio', {
  user: { profile: null },
})
ev(
  'array map and join',
  'items.map(fn).join(" | ")',
  '1 | 4 | 9',
  { items: [1, 2, 3], fn: callable('square') },
  { callPolicy: 'allow-all' },
  { portability: 'host-callback' },
)
ev(
  'object property access and formatting',
  '`${user.firstName} ${user.lastName} (${user.age})`',
  'Jane Doe (30)',
  { user: { firstName: 'Jane', lastName: 'Doe', age: 30 } },
)
ev(
  'pipeline for data transformation',
  '"  hello  " |> trim(%) |> upper(%)',
  'HELLO',
  { trim: callable('trim'), upper: callable('upper') },
  { callPolicy: 'allow-all' },
  { portability: 'host-callback' },
)
ev('numeric separator in source', '1_000_000 + 234_567', 1234567)

// Template parser and renderer cases.
const templateParse = (name, source, expect, options = {}) =>
  add('template parser', name, { op: 'parse-template', source, options, expect })
const templateRender = (name, source, context, expect, options = {}, metadata = {}) =>
  add(
    'template renderer',
    name,
    { op: 'render-template', source, context, options, expect },
    metadata,
  )

templateParse(
  'parses plain text',
  'hello world',
  matchExpectation({
    errors: [],
    segments: [{ type: 'text', value: 'hello world' }],
  }),
)
templateParse(
  'parses expression with double braces',
  'Hi {{ user.name }}!',
  matchExpectation({
    errors: [],
    segments: [
      { type: 'text' },
      { type: 'expression', expr: 'user.name', delimiterLength: 2 },
      { type: 'text' },
    ],
  }),
)
templateParse(
  'supports longer matching delimiters',
  'Value: {{{{ a + 1 }}}}',
  matchExpectation({
    errors: [],
    segments: [{ type: 'text' }, { type: 'expression', expr: 'a + 1', delimiterLength: 4 }],
  }),
)
templateParse(
  'keeps object literal braces inside expression',
  'X {{ ({ a: 1 }).a }} Y',
  matchExpectation({
    errors: [],
    segments: [{ type: 'text' }, { type: 'expression', expr: '({ a: 1 }).a' }, { type: 'text' }],
  }),
)
templateParse(
  'supports longer delimiters when the expression contains a shorter closing run',
  'Value: {{{{ "}}" }}}}',
  matchExpectation({
    errors: [],
    segments: [{ type: 'text' }, { type: 'expression', expr: '"}}"', delimiterLength: 4 }],
  }),
)
templateParse(
  'matches the next closing delimiter run without parsing expression syntax',
  'A {{ /* }} */ 1 }} B',
  matchExpectation({
    errors: [],
    segments: [
      { type: 'text', value: 'A ' },
      { type: 'expression', expr: '/*', delimiterLength: 2 },
      { type: 'text', value: ' */ 1 }} B' },
    ],
  }),
)
templateParse(
  'reports unclosed expression',
  'Hi {{ user.name',
  matchExpectation({ errors: [{ kind: 'template' }] }, [{ path: '/errors/length', equals: 1 }]),
)
templateParse(
  'rejects oversized template sources',
  'hello world',
  matchExpectation({ segments: [] }, [
    { path: '/errors/0/message', contains: 'maximum source length' },
  ]),
  { maxSourceLength: 5 },
)
templateParse(
  'rejects templates with too many placeholders',
  'A {{ first }} B {{ second }}',
  matchExpectation({ segments: [] }, [
    { path: '/errors/0/message', contains: 'maximum placeholder count' },
  ]),
  { maxPlaceholders: 1 },
)
templateRender(
  'renders markdown template',
  'Hi {{ name }}',
  { name: 'John' },
  valueExpectation({ output: 'Hi John', errors: [] }),
)
templateRender(
  'renders html-safe values when format=html',
  '<p>{{ html }}</p>',
  { html: '<b>X</b>' },
  valueExpectation({ output: '<p>&lt;b&gt;X&lt;/b&gt;</p>', errors: [] }),
  { format: 'html' },
)
templateRender(
  'collects eval errors in non-strict mode',
  'A {{ unknown }} B',
  {},
  matchExpectation({ output: 'A  B', errors: [{ kind: 'eval' }] }, [
    { path: '/errors/length', equals: 1 },
  ]),
)
templateRender(
  'stops in strict mode on first error',
  'A {{ unknown }} B {{ 1 + 1 }}',
  {},
  matchExpectation({ output: 'A ', errors: [{ kind: 'eval' }] }, [
    { path: '/errors/length', equals: 1 },
  ]),
  { strict: true },
)
templateRender(
  'forwards eval options to expression rendering',
  'Hi {{ format(name) }}',
  { name: 'Ada', format: callable('upper') },
  valueExpectation({ output: 'Hi ADA', errors: [] }),
  { evalOptions: { callPolicy: 'allow-all' } },
  { portability: 'host-callback' },
)
add('template renderer', 'compileTemplate supports repeated rendering', {
  op: 'compile-template-render',
  source: 'Hi {{ name }}',
  options: {},
  contexts: [{ name: 'Ada' }, { name: 'Linus' }],
  expect: valueExpectation([
    { output: 'Hi Ada', errors: [] },
    { output: 'Hi Linus', errors: [] },
  ]),
})
add(
  'template renderer',
  'compileTemplate reuses baked eval options',
  {
    op: 'compile-template-render',
    source: 'Hi {{ format(name) }}',
    options: { evalOptions: { callPolicy: 'allow-all' } },
    contexts: [{ name: 'Ada', format: callable('upper') }],
    expect: valueExpectation([{ output: 'Hi ADA', errors: [] }]),
  },
  { portability: 'host-callback' },
)
add('template renderer', 'compileTemplate surfaces precomputed parse errors during rendering', {
  op: 'compile-template-render',
  source: 'A {{ value + }} B',
  options: {},
  contexts: [{ value: 1 }],
  expect: matchExpectation(
    [{ output: 'A  B', errors: [{ kind: 'parse' }] }],
    [{ path: '/0/errors/length', equals: 1 }],
  ),
})
templateRender(
  'applies template parse budgets during rendering',
  'A {{ first }} B {{ second }}',
  { first: 'x', second: 'y' },
  matchExpectation({ output: '', errors: [{}] }, [
    { path: '/errors/0/message', contains: 'maximum placeholder count' },
  ]),
  { maxPlaceholders: 1 },
)

// Public API cases are expressed in implementation-neutral operations.
add('public API', 'tokenizeExpression exposes lexer output', {
  op: 'tokenize-expression',
  source: 'count + 1',
  options: {},
  expect: valueExpectation(['count', '+', '1']),
})
add(
  'public API',
  'parseExpression exposes the expression AST',
  parseCheck('count + 1', { type: 'binary', operator: '+' }),
)
add('public API', 'compileExpression supports reusable evaluation', {
  op: 'compile-evaluate',
  source: 'count + 1',
  options: {},
  contexts: [{ count: 1 }, { count: 4 }],
  expect: valueExpectation([2, 5]),
})
add(
  'public API',
  'compileExpression supports generated arrow functions with the default call policy',
  {
    op: 'compile-evaluate',
    source: '(value => value + step)(count)',
    options: {},
    contexts: [{ count: 2, step: 3 }],
    expect: valueExpectation([5]),
  },
)
add(
  'public API',
  'compileExpression supports the performance function backend for generated arrows',
  {
    op: 'compile-evaluate',
    source: '(value => value + step)(count)',
    options: { functionMode: 'performance' },
    contexts: [{ count: 2, step: 3 }],
    expect: valueExpectation([5]),
  },
)
add('public API', 'compile alias is exported from the root entrypoint', {
  op: 'compile-evaluate',
  source: 'count + 2',
  options: {},
  contexts: [{ count: 3 }],
  includeSource: true,
  expect: valueExpectation({ source: 'count + 2', values: [5] }),
})
add(
  'public API',
  'allowAllCalls is exported from the root entrypoint',
  {
    op: 'compile-evaluate',
    source: 'double(count)',
    options: { callPolicy: 'allow-all' },
    contexts: [{ count: 3, double: callable('multiply', { factor: 2 }) }],
    expect: valueExpectation([6]),
  },
  { portability: 'host-callback' },
)
add(
  'public API',
  'defaultCallPermissionPolicy is exported from the root entrypoint',
  {
    op: 'call-permission',
    callable: 'String.prototype.normalize',
    receiver: 'A\u030A',
    kind: 'call',
    source: '"A\\u030A".normalize("NFC")',
    expect: valueExpectation(true),
  },
  { portability: 'js-host-policy' },
)
add(
  'public API',
  'parseExpression can disable arrow functions',
  parseErrorCheck('value => value', 'Arrow functions are not enabled', {
    allowArrowFunctions: false,
  }),
)
add('public API', 'JSEvaluator merges base and per-call contexts without leaking overrides', {
  op: 'evaluator-evaluate',
  source: 'count + step',
  options: {},
  baseContext: { count: 1, step: 2 },
  contexts: [null, { count: 5 }, null],
  expect: valueExpectation([3, 7, 3]),
})
add('public API', 'template helpers remain available from the root entrypoint', [
  {
    op: 'parse-template',
    source: 'Hi {{ name }}',
    options: {},
    expect: { paths: [{ path: '/segments/length', equals: 2 }] },
  },
  {
    op: 'render-template',
    source: 'Hi {{ name }}',
    context: { name: 'Ada' },
    options: {},
    expect: matchExpectation({ output: 'Hi Ada' }),
  },
])
add('public API', 'compileTemplate is exported from the root entrypoint', {
  op: 'compile-template-render',
  source: 'Hi {{ name }}',
  options: {},
  contexts: [{ name: 'Ada' }],
  includeSource: true,
  expect: valueExpectation({ source: 'Hi {{ name }}', values: [{ output: 'Hi Ada', errors: [] }] }),
})

async function extractLegacyTests() {
  const files = [
    ['tests/evaluator.test.ts', 'evaluator'],
    ['tests/template.test.ts', null],
    ['tests/public-api.test.ts', 'public API'],
  ]
  const result = []

  for (const [file, fixedSuite] of files) {
    const source = await readFile(resolve(ROOT, file), 'utf8')
    let currentSuite = fixedSuite
    for (const line of source.split(/\r?\n/)) {
      const suiteMatch = line.match(/^describe\('([^']+)'/)
      if (suiteMatch) currentSuite = suiteMatch[1]
      const testMatch = line.match(/^\s{2}test\('([^']+)'/)
      if (testMatch) result.push({ file, suite: currentSuite, name: testMatch[1] })
    }
  }
  return result
}

const legacyTests = await extractLegacyTests()
const missing = []
for (const test of legacyTests) {
  const key = `${test.suite}\u0000${test.name}`
  const definition = definitions.get(key)
  if (!definition) {
    missing.push(`${test.file}: ${test.suite} > ${test.name}`)
    continue
  }
  definition.sourceTest.file = test.file
  definitions.delete(key)
}

if (missing.length > 0 || definitions.size > 0) {
  const extras = [...definitions.values()].map(
    (entry) => `${entry.sourceTest.suite} > ${entry.sourceTest.name}`,
  )
  throw new Error(
    [
      missing.length ? `Missing definitions:\n${missing.join('\n')}` : '',
      extras.length ? `Definitions without legacy tests:\n${extras.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  )
}

const orderedCases = legacyTests.map((test) => {
  // Definitions were deleted after validation, so find the now-annotated object by id.
  return allDefinitions.find(
    (entry) => entry.sourceTest.suite === test.suite && entry.sourceTest.name === test.name,
  )
})

const corpus = {
  schemaVersion: 1,
  corpusVersion: '1.0.0',
  semanticProfile: 'legacy-js-v1',
  description: 'Language-neutral behavioral corpus frozen from the pure-expr TypeScript tests.',
  legacyTestCount: legacyTests.length,
  caseCount: orderedCases.length,
  cases: orderedCases,
}

const serialized = `${JSON.stringify(corpus, null, 2)}\n`
if (CHECK_ONLY) {
  const existing = await readFile(OUTPUT, 'utf8').catch(() => '')
  if (existing !== serialized) {
    throw new Error('Conformance corpus is stale. Run `pnpm run conformance:generate`.')
  }
} else {
  await mkdir(dirname(OUTPUT), { recursive: true })
  await writeFile(OUTPUT, serialized)
}
