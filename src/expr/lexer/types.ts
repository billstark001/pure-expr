import type { JSLexer } from './lexer.js'

export class JSLexError extends Error {
  constructor(
    message: string,
    public readonly pos: number,
    src = '',
    public readonly code: 'invalid' | 'unexpected-character' | 'unterminated' = 'invalid',
  ) {
    const lo = Math.max(0, pos - 15)
    const hi = Math.min(src.length, pos + 15)
    const ctx = src ? ` (near: \`${src.slice(lo, hi)}\`)` : ''
    super(`${message} at position ${pos}${ctx}`)
    this.name = 'JSLexError'
  }
}

export type JSTokenKind =
  | 'number'
  | 'bigint'
  | 'string'
  | 'boolean'
  | 'null'
  | 'undefined'
  | 'identifier'
  | 'regex'
  | 'template'
  | 'op'

export interface TemplateQuasi {
  /** Source spelling between template delimiters. */
  raw: string
  /** Cooked value, or null when the escape sequence is invalid. */
  cooked: string | null
}

/** Token emitted by {@link JSLexer}. */
export interface JSToken {
  kind: JSTokenKind
  /** Semantic token value consumed by the parser. */
  value: string
  /** Exact source spelling when `JSLexerOptions.raw` is enabled. */
  raw?: string
  start: number
  end: number
  /** Template segments and recursively tokenized expressions. */
  tmpl?: {
    quasis: TemplateQuasi[]
    /** Parser metadata for locating each quasi in the original source. */
    quasiRanges?: Array<{ start: number; end: number }>
    exprTokens: JSToken[][]
  }
}

export type NumberRadix = 2 | 8 | 10 | 16

/** Controls which JavaScript number-literal forms the lexer accepts. */
export interface JSNumberOptions {
  radices?: readonly NumberRadix[]
  bigint?: boolean
  separators?: boolean
}

export interface JSLexerRule {
  /** Return true when this rule owns the token beginning at `pos`. */
  match(this: JSLexer, src: string, pos: number, prev: readonly JSToken[]): boolean
  /** Return one token whose range begins at `pos` and advances the lexer. */
  advance(this: JSLexer, src: string, pos: number, prev: readonly JSToken[]): JSToken
}

/** Options for low-level expression tokenization. */
export interface JSLexerOptions {
  /** Begin tokenization at this absolute UTF-16 offset. Defaults to zero. */
  start?: number
  /** Include each token's exact source spelling in its optional `raw` field. */
  raw?: boolean
  /** Restrict accepted number-literal forms. All forms are enabled by default. */
  numbers?: JSNumberOptions
  /** Ordered custom rules checked before the built-in token scanners. */
  rules?: readonly JSLexerRule[]
}
