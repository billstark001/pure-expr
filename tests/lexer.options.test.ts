import { describe, expect, it } from 'vitest'
import { JSEvaluator, JSExpressionParser, JSLexer, type JSLexerRule } from '../src/index.js'

const rewriteRules: readonly JSLexerRule[] = [
  {
    match: (src, pos) => src.startsWith('^^', pos),
    advance: (_src, pos) => ({ kind: 'op', value: '%', start: pos, end: pos + 2 }),
  },
  {
    match: (src, pos) => src.startsWith('add', pos),
    advance: (_src, pos) => ({ kind: 'op', value: '+', start: pos, end: pos + 3 }),
  },
]

describe('token value/raw behavior', () => {
  it('omits raw by default', () => {
    const tokens = new JSLexer('a add 0xff', { rules: rewriteRules }).tokenize()
    expect(tokens.map((token) => token.value)).toEqual(['a', '+', '0xff'])
    for (const token of tokens) expect(token).not.toHaveProperty('raw')
  })

  it('preserves source spelling when raw is enabled', () => {
    const tokens = new JSLexer('a add 0xff ^^ 0x2', { raw: true, rules: rewriteRules }).tokenize()
    expect(tokens.map(({ value, raw }) => ({ value, raw }))).toEqual([
      { value: 'a', raw: 'a' },
      { value: '+', raw: 'add' },
      { value: '0xff', raw: '0xff' },
      { value: '%', raw: '^^' },
      { value: '0x2', raw: '0x2' },
    ])
  })
})

describe('rule registry', () => {
  it('runs before built-in token dispatch', () => {
    const rules: readonly JSLexerRule[] = [
      {
        match: (src, pos) => src.startsWith('true', pos),
        advance: (_src, pos) => ({ kind: 'identifier', value: 'truth', start: pos, end: pos + 4 }),
      },
    ]
    expect(new JSLexer('true', { rules }).tokenize()[0]).toMatchObject({
      kind: 'identifier',
      value: 'truth',
    })
  })

  it('supports arrow functions and binds keyword functions to the lexer at call time', () => {
    let matchThis: JSLexer | undefined
    let advanceThis: JSLexer | undefined

    const rules: readonly JSLexerRule[] = [
      {
        match: function (src, pos) {
          matchThis = this
          return src.startsWith('word', pos)
        },
        advance: function (_src, pos) {
          advanceThis = this
          expect(this.position).toBe(pos)
          return { kind: 'identifier', value: 'mapped', start: pos, end: pos + 4 }
        },
      },
    ]

    const lexer = new JSLexer('word', { rules })
    expect(lexer.tokenize()[0].value).toBe('mapped')
    expect(matchThis).toBe(lexer)
    expect(advanceThis).toBe(lexer)
  })

  it('uses rewritten operator values for following regex context', () => {
    const tokens = new JSLexer('a add /x/', { rules: rewriteRules }).tokenize()
    expect(tokens.map(({ kind, value }) => ({ kind, value }))).toEqual([
      { kind: 'identifier', value: 'a' },
      { kind: 'op', value: '+' },
      { kind: 'regex', value: '/x/' },
    ])
  })

  it('feeds rewritten values into the parser and evaluator', () => {
    const source = 'enabled add visible'
    const tokens = new JSLexer(source, { rules: rewriteRules }).tokenize()
    const ast = new JSExpressionParser(tokens, {}, source).parse()

    expect(new JSEvaluator({ enabled: 2, visible: 3 }).evaluate(ast)).toBe(5)
  })

  it('applies rules recursively inside template expressions', () => {
    const [template] = new JSLexer('`sum:${left add right}`', {
      raw: true,
      rules: rewriteRules,
    }).tokenize()

    expect(template.tmpl?.exprTokens[0].map(({ value, raw }) => ({ value, raw }))).toEqual([
      { value: 'left', raw: 'left' },
      { value: '+', raw: 'add' },
      { value: 'right', raw: 'right' },
    ])
  })

  it.each([
    ['empty range', (pos: number) => ({ kind: 'op' as const, value: '+', start: pos, end: pos })],
    [
      'wrong start',
      (pos: number) => ({ kind: 'op' as const, value: '+', start: pos + 1, end: pos + 2 }),
    ],
    [
      'past source end',
      (pos: number) => ({ kind: 'op' as const, value: '+', start: pos, end: pos + 2 }),
    ],
    [
      'non-integer end',
      (pos: number) => ({ kind: 'op' as const, value: '+', start: pos, end: pos + 0.5 }),
    ],
  ])('rejects a rule token with %s', (_label, makeToken) => {
    const rules: readonly JSLexerRule[] = [
      {
        match: () => true,
        advance: (_src, pos) => makeToken(pos),
      },
    ]
    expect(() => new JSLexer('x', { rules }).tokenize()).toThrow(TypeError)
  })
})

describe('number policy', () => {
  it('accepts strict valid number forms', () => {
    const source =
      '0 1 1_000 1.2 1. .5 1e3 1.e2 1_0.2_0e+3_0 0xff 0xFF_FF 0b1010_0101 0o755 1n 0xffn'
    expect(new JSLexer(source).tokenize().map((token) => token.value)).toEqual(source.split(' '))
  })

  it('can allow only hexadecimal literals', () => {
    const options = { numbers: { radices: [16] as const } }
    expect(new JSLexer('0xff 0x10n', options).tokenize().map((token) => token.value)).toEqual([
      '0xff',
      '0x10n',
    ])
    expect(() => new JSLexer('10', options).tokenize()).toThrow(
      'Base-10 number literals are not allowed',
    )
  })

  it('can disable bigint and numeric separators', () => {
    expect(() => new JSLexer('1n', { numbers: { bigint: false } }).tokenize()).toThrow(
      'BigInt literals are not allowed',
    )
    expect(() => new JSLexer('1_000', { numbers: { separators: false } }).tokenize()).toThrow(
      'Numeric separators are not allowed',
    )
  })

  it('can reject every numeric radix while leaving other tokens available', () => {
    const options = { numbers: { radices: [] } }
    expect(new JSLexer('name', options).tokenize()[0].value).toBe('name')
    expect(() => new JSLexer('0', options).tokenize()).toThrow(
      'Base-10 number literals are not allowed',
    )
  })

  it('rejects unsupported radix configuration at construction time', () => {
    expect(() => new JSLexer('value', { numbers: { radices: [3] as never[] } })).toThrow(
      'Unsupported number radix: 3',
    )
  })
})
