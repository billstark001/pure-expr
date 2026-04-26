// #region Lexer errors and token types

/** Error raised while tokenizing an expression source string. */
export class JSLexError extends Error {
  constructor(
    message: string,
    public readonly pos: number,
    src = '',
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

/** One cooked/raw segment inside a template literal token. */
export interface TemplateQuasi {
  raw: string
  cooked: string | null
}

/** Token emitted by JSLexer. */
export interface JSToken {
  kind: JSTokenKind
  raw: string
  start: number
  end: number
  /** Populated for template tokens only */
  tmpl?: {
    quasis: TemplateQuasi[]
    exprTokens: JSToken[][]
  }
}

// #endregion

// #region Lexer internals

// Sticky regex helpers – each is reset before use
const RX_TRIVIA = /(?:[ \t\r\n\f\v]+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/y
const RX_NUMBER =
  /(?:0[xX][\da-fA-F][\da-fA-F_]*|0[oO][0-7_]*|0[bB][01_]*|(?:0|[1-9][\d_]*)(?:\.[\d_]*)?(?:[eE][+\-]?[\d_]+)?|\.[\d_]+(?:[eE][+\-]?[\d_]+)?)n?/y
const RX_STRING = /(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/y
const RX_IDENT = /[a-zA-Z_$][\w$]*/y
const RX_OP =
  /(?:>>>=|\.{3}|===|!==|>>>|<<=|>>=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|\?\?=|\|\|=|&&=|\*\*=|\+\+|--|==|!=|<=|>=|<<|>>|\*\*|&&|\|\||\?\?|\|>|\?\.|=>|[=+\-*\/%&|^~!<>?:.,()[\]{};])/y

const REGEX_CONTEXT_KEYWORDS = new Set([
  'typeof',
  'void',
  'instanceof',
  'in',
  'return',
  'throw',
  'case',
  'else',
  'new',
  'delete',
  'await',
  'of',
])

function stickyAt<T extends RegExp>(re: T, src: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos
  return re.exec(src)
}

function isHexDigit(value: string | undefined): value is string {
  return value !== undefined && /[0-9a-fA-F]/.test(value)
}

function isLineTerminator(value: string | undefined): boolean {
  return value === '\n' || value === '\r' || value === '\u2028' || value === '\u2029'
}

function consumeLineContinuation(raw: string, index: number): number | null {
  const ch = raw[index]
  if (ch === '\r' && raw[index + 1] === '\n') return index + 1
  return isLineTerminator(ch) ? index : null
}

// #endregion

// #region Public lexer

/** Converts expression source text into a token stream. */
export class JSLexer {
  private pos = 0

  constructor(private readonly src: string) {}

  tokenize(): JSToken[] {
    const tokens: JSToken[] = []
    while (this.pos < this.src.length) {
      // skip whitespace / comments
      const ws = stickyAt(RX_TRIVIA, this.src, this.pos)
      if (ws) {
        this.pos += ws[0].length
        continue
      }

      tokens.push(this.lexToken(tokens))
    }
    return tokens
  }

  private lexToken(prev: JSToken[]): JSToken {
    const ch = this.src[this.pos]

    if (ch === '`') return this.lexTemplate()
    if (ch === '/' && this.isRegexCtx(prev)) return this.lexRegex()
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(this.src[this.pos + 1] ?? '')))
      return this.lexNumber()
    if (ch === '"' || ch === "'") return this.lexString()
    if (/[a-zA-Z_$]/.test(ch)) return this.lexIdent()
    return this.lexOp()
  }

  private isRegexCtx(prev: JSToken[]): boolean {
    if (prev.length === 0) return true
    const last = prev[prev.length - 1]
    if (last.kind === 'identifier') {
      return REGEX_CONTEXT_KEYWORDS.has(last.raw)
    }
    if (last.kind === 'op') {
      return ![')', ']', '}'].includes(last.raw)
    }
    // after any literal it's division
    return false
  }

  private lexNumber(): JSToken {
    const m = stickyAt(RX_NUMBER, this.src, this.pos)
    if (!m || m[0].length === 0) throw new JSLexError('Invalid number literal', this.pos, this.src)
    const raw = m[0]
    const start = this.pos
    this.pos += raw.length
    return {
      kind: raw.endsWith('n') ? 'bigint' : 'number',
      raw,
      start,
      end: this.pos,
    }
  }

  private lexString(): JSToken {
    const m = stickyAt(RX_STRING, this.src, this.pos)
    if (!m) throw new JSLexError('Unterminated string literal', this.pos, this.src)
    const start = this.pos
    this.pos += m[0].length
    return { kind: 'string', raw: m[0], start, end: this.pos }
  }

  private lexIdent(): JSToken {
    const m = stickyAt(RX_IDENT, this.src, this.pos)!
    const raw = m[0]
    const start = this.pos
    this.pos += raw.length
    if (raw === 'true' || raw === 'false') return { kind: 'boolean', raw, start, end: this.pos }
    if (raw === 'null') return { kind: 'null', raw, start, end: this.pos }
    if (raw === 'undefined') return { kind: 'undefined', raw, start, end: this.pos }
    return { kind: 'identifier', raw, start, end: this.pos }
  }

  private lexRegex(): JSToken {
    const start = this.pos++ // skip /
    let inClass = false
    while (this.pos < this.src.length) {
      const c = this.src[this.pos++]
      if (c === '\\') {
        this.pos++
      } else if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) {
        while (this.pos < this.src.length && /[gimsuyv]/.test(this.src[this.pos])) this.pos++
        return { kind: 'regex', raw: this.src.slice(start, this.pos), start, end: this.pos }
      } else if (c === '\n') {
        throw new JSLexError('Unterminated regex literal', start, this.src)
      }
    }
    throw new JSLexError('Unterminated regex literal', start, this.src)
  }

  private lexTemplate(): JSToken {
    const start = this.pos++ // skip `
    const quasis: TemplateQuasi[] = []
    const exprTokens: JSToken[][] = []
    let rawBuf = ''

    while (this.pos < this.src.length) {
      const c = this.src[this.pos]
      if (c === '\\') {
        rawBuf += this.src.slice(this.pos, this.pos + 2)
        this.pos += 2
      } else if (c === '`') {
        this.pos++
        quasis.push({ raw: rawBuf, cooked: cookTemplate(rawBuf) })
        return {
          kind: 'template',
          raw: this.src.slice(start, this.pos),
          start,
          end: this.pos,
          tmpl: { quasis, exprTokens },
        }
      } else if (c === '$' && this.src[this.pos + 1] === '{') {
        quasis.push({ raw: rawBuf, cooked: cookTemplate(rawBuf) })
        rawBuf = ''
        this.pos += 2 // skip ${
        exprTokens.push(this.lexTemplateExpr())
      } else {
        rawBuf += c
        this.pos++
      }
    }
    throw new JSLexError('Unterminated template literal', start, this.src)
  }

  private lexTemplateExpr(): JSToken[] {
    const tokens: JSToken[] = []
    let depth = 0
    while (this.pos < this.src.length) {
      const ws = stickyAt(RX_TRIVIA, this.src, this.pos)
      if (ws) {
        this.pos += ws[0].length
        continue
      }
      if (this.pos >= this.src.length) break
      const c = this.src[this.pos]
      if (c === '}' && depth === 0) {
        this.pos++
        return tokens
      }

      // Read the next token normally (template literals and regex literals nest recursively)
      const tok = this.lexToken(tokens)
      if (tok.kind === 'op') {
        if (tok.raw === '{') depth++
        else if (tok.raw === '}') depth--
      }
      tokens.push(tok)
    }
    throw new JSLexError('Unterminated template expression', this.pos, this.src)
  }

  private lexOp(): JSToken {
    const m = stickyAt(RX_OP, this.src, this.pos)
    if (!m) throw new JSLexError(`Unexpected character '${this.src[this.pos]}'`, this.pos, this.src)
    const start = this.pos
    this.pos += m[0].length
    return { kind: 'op', raw: m[0], start, end: this.pos }
  }
}

// #endregion

// #region Template cooking

/** Convert a raw template fragment into its cooked string representation. */
export function cookTemplate(raw: string): string | null {
  let cooked = ''

  for (let index = 0; index < raw.length; index++) {
    const ch = raw[index]
    if (ch !== '\\') {
      cooked += ch
      continue
    }

    const next = raw[index + 1]
    if (next === undefined) return null

    const lineContinuationEnd = consumeLineContinuation(raw, index + 1)
    if (lineContinuationEnd !== null) {
      index = lineContinuationEnd
      continue
    }

    if (next === '0') {
      if (/\d/.test(raw[index + 2] ?? '')) return null
      cooked += '\0'
      index += 1
      continue
    }

    if (next === 'b') {
      cooked += '\b'
      index += 1
      continue
    }
    if (next === 'f') {
      cooked += '\f'
      index += 1
      continue
    }
    if (next === 'n') {
      cooked += '\n'
      index += 1
      continue
    }
    if (next === 'r') {
      cooked += '\r'
      index += 1
      continue
    }
    if (next === 't') {
      cooked += '\t'
      index += 1
      continue
    }
    if (next === 'v') {
      cooked += '\v'
      index += 1
      continue
    }
    if (next === '`' || next === '$' || next === '\\') {
      cooked += next
      index += 1
      continue
    }

    if (next === 'x') {
      const hex = raw.slice(index + 2, index + 4)
      if (hex.length !== 2 || ![...hex].every(isHexDigit)) return null
      cooked += String.fromCharCode(Number.parseInt(hex, 16))
      index += 3
      continue
    }

    if (next === 'u') {
      if (raw[index + 2] === '{') {
        let end = index + 3
        while (end < raw.length && raw[end] !== '}') {
          if (!isHexDigit(raw[end])) return null
          end++
        }

        if (end === index + 3 || raw[end] !== '}') return null

        const codePoint = Number.parseInt(raw.slice(index + 3, end), 16)
        if (codePoint > 0x10ffff) return null
        cooked += String.fromCodePoint(codePoint)
        index = end
        continue
      }

      const hex = raw.slice(index + 2, index + 6)
      if (hex.length !== 4 || ![...hex].every(isHexDigit)) return null
      cooked += String.fromCharCode(Number.parseInt(hex, 16))
      index += 5
      continue
    }

    if (/\d/.test(next)) return null

    cooked += next
    index += 1
  }

  return cooked
}

// #endregion
