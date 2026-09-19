import { describe, expect, it } from 'vitest'
import { cookTemplate, JSLexError, JSLexer } from '../src/expr/lexer/index.js'
import { LEXICAL_PUNCTUATORS } from '../src/expr/operators.js'

function compact(source: string) {
  return new JSLexer(source).tokenize().map((token) => ({
    kind: token.kind,
    value: token.value,
    start: token.start,
    end: token.end,
  }))
}

describe('core tokenization', () => {
  it('lexes primitive literals and identifiers', () => {
    expect(compact('foo true false null undefined "x" \'y\'')).toEqual([
      { kind: 'identifier', value: 'foo', start: 0, end: 3 },
      { kind: 'boolean', value: 'true', start: 4, end: 8 },
      { kind: 'boolean', value: 'false', start: 9, end: 14 },
      { kind: 'null', value: 'null', start: 15, end: 19 },
      { kind: 'undefined', value: 'undefined', start: 20, end: 29 },
      { kind: 'string', value: '"x"', start: 30, end: 33 },
      { kind: 'string', value: "'y'", start: 34, end: 37 },
    ])
  })

  it('skips whitespace and comments', () => {
    expect(
      compact('a /* block */ + // line\n b').map(({ kind, value }) => ({ kind, value })),
    ).toEqual([
      { kind: 'identifier', value: 'a' },
      { kind: 'op', value: '+' },
      { kind: 'identifier', value: 'b' },
    ])
  })

  it('distinguishes regex literals from division using the existing context heuristic', () => {
    const tokens = new JSLexer('/ab+c/g; a / b; return /x/i').tokenize()
    expect(tokens.map((token) => ({ kind: token.kind, value: token.value }))).toEqual([
      { kind: 'regex', value: '/ab+c/g' },
      { kind: 'op', value: ';' },
      { kind: 'identifier', value: 'a' },
      { kind: 'op', value: '/' },
      { kind: 'identifier', value: 'b' },
      { kind: 'op', value: ';' },
      { kind: 'identifier', value: 'return' },
      { kind: 'regex', value: '/x/i' },
    ])
  })

  it('lexes every registered punctuator with maximal munch', () => {
    for (const operator of LEXICAL_PUNCTUATORS) {
      const tokens = new JSLexer(`a ${operator} b`).tokenize()
      expect(tokens[1].kind).toBe('op')
      expect(tokens[1].value).toBe(operator)
    }
  })

  it('lexes nested template expressions', () => {
    const [token] = new JSLexer('`a${x + 1}b${{y: 2}.y}c`').tokenize()
    expect(token.kind).toBe('template')
    expect(token.value).toBe('`a${x + 1}b${{y: 2}.y}c`')
    expect(token.tmpl?.quasis).toEqual([
      { raw: 'a', cooked: 'a' },
      { raw: 'b', cooked: 'b' },
      { raw: 'c', cooked: 'c' },
    ])
    expect(token.tmpl?.exprTokens).toHaveLength(2)
    expect(token.tmpl?.exprTokens[0].map(({ value }) => value)).toEqual(['x', '+', '1'])
    expect(token.tmpl?.exprTokens[1].map(({ value }) => value)).toEqual([
      '{',
      'y',
      ':',
      '2',
      '}',
      '.',
      'y',
    ])
  })

  it('keeps template cooking behavior', () => {
    expect(cookTemplate(String.raw`a\n\x41\u0042\u{43}`)).toBe('a\nABC')
    expect(cookTemplate(String.raw`\8`)).toBeNull()
    expect(cookTemplate(String.raw`\u{110000}`)).toBeNull()
  })

  it('allows member access after non-decimal number literals', () => {
    expect(new JSLexer('0xff.toString').tokenize().map(({ value }) => value)).toEqual([
      '0xff',
      '.',
      'toString',
    ])
  })

  it('throws on unexpected characters and unterminated constructs', () => {
    expect(() => new JSLexer('@').tokenize()).toThrow(JSLexError)
    expect(() => new JSLexer('/abc').tokenize()).toThrow('Unterminated regex literal')
    expect(() => new JSLexer('`abc').tokenize()).toThrow('Unterminated template literal')
  })

  it('reports the final lexer position after consuming trivia and tokens', () => {
    const source = ' value + 1 // trailing comment'
    const lexer = new JSLexer(source)

    expect(lexer.position).toBe(0)
    expect(lexer.tokenize().map(({ value }) => value)).toEqual(['value', '+', '1'])
    expect(lexer.position).toBe(source.length)
  })

  it('supports incremental token reads from an absolute source offset', () => {
    const source = 'prefix value + 1 suffix'
    const lexer = new JSLexer(source, { start: source.indexOf('value') })

    expect(lexer.nextToken()).toMatchObject({ value: 'value', start: 7, end: 12 })
    expect(lexer.nextToken()).toMatchObject({ value: '+', start: 13, end: 14 })
    expect(lexer.tokenize().map(({ value }) => value)).toEqual(['1', 'suffix'])
    expect(lexer.nextToken()).toBeUndefined()
  })
})

describe('corrected legacy lexer errors', () => {
  it.each([
    '0x',
    '0x_1',
    '0x1_',
    '0x1__2',
    '0b',
    '0b2',
    '0b102',
    '0o8',
    '1_',
    '1__2',
    '1._2',
    '1e',
    '1e+',
    '1e_2',
    '1.2n',
  ])('rejects malformed number literal %s', (source: string) => {
    expect(() => new JSLexer(source).tokenize()).toThrow('Invalid number literal')
  })

  it('does not form optional chaining before a decimal digit', () => {
    expect(new JSLexer('a?.3:0').tokenize().map((token) => token.value)).toEqual([
      'a',
      '?',
      '.3',
      ':',
      '0',
    ])
  })

  it('accepts escaped line continuations inside strings', () => {
    const source = '"a\\' + '\n' + 'b"'
    expect(new JSLexer(source).tokenize().map(({ value }) => value)).toEqual([source])
  })

  it('rejects raw line breaks inside strings', () => {
    expect(() => new JSLexer('"a\nb"').tokenize()).toThrow('Unterminated string literal')
  })

  it('reports unterminated block comments directly', () => {
    expect(() => new JSLexer('/* nope').tokenize()).toThrow('Unterminated block comment')
  })
})
