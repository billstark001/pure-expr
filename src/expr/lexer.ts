export class JSLexError extends Error {
  constructor(
    message: string,
    public readonly pos: number,
    src = ''
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
  raw: string
  cooked: string | null
}

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

// Sticky regex helpers – each is reset before use
const RX_TRIVIA  = /(?:[ \t\r\n\f\v]+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/y
const RX_NUMBER  = /(?:0[xX][\da-fA-F][\da-fA-F_]*|0[oO][0-7_]*|0[bB][01_]*|(?:0|[1-9][\d_]*)(?:\.[\d_]*)?(?:[eE][+\-]?[\d_]+)?|\.[\d_]+(?:[eE][+\-]?[\d_]+)?)n?/y
const RX_STRING  = /(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/y
const RX_IDENT   = /[a-zA-Z_$][\w$]*/y
const RX_OP      = /(?:>>>=|\.{3}|===|!==|>>>|<<=|>>=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|\?\?=|\|\|=|&&=|\*\*=|\+\+|--|==|!=|<=|>=|<<|>>|\*\*|&&|\|\||\?\?|\|>|\?\.|=>|[=+\-*\/%&|^~!<>?:.,()[\]{};])/y

function stickyAt<T extends RegExp>(re: T, src: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos
  return re.exec(src)
}

export class JSLexer {
  private pos = 0

  constructor(private readonly src: string) {}

  tokenize(): JSToken[] {
    const tokens: JSToken[] = []
    while (this.pos < this.src.length) {
      // skip whitespace / comments
      const ws = stickyAt(RX_TRIVIA, this.src, this.pos)
      if (ws) { this.pos += ws[0].length; continue }

      const ch = this.src[this.pos]

      if (ch === '`') { tokens.push(this.lexTemplate()); continue }
      if ((ch === '/' || ch === '/') && this.isRegexCtx(tokens)) {
        tokens.push(this.lexRegex()); continue
      }

      let tok: JSToken | null = null
      if (/\d/.test(ch) || (ch === '.' && /\d/.test(this.src[this.pos + 1] ?? ''))) {
        tok = this.lexNumber()
      } else if (ch === '"' || ch === "'") {
        tok = this.lexString()
      } else if (/[a-zA-Z_$]/.test(ch)) {
        tok = this.lexIdent()
      } else {
        tok = this.lexOp()
      }

      if (!tok) throw new JSLexError(`Unexpected character '${ch}'`, this.pos, this.src)
      tokens.push(tok)
    }
    return tokens
  }

  private isRegexCtx(prev: JSToken[]): boolean {
    if (prev.length === 0) return true
    const last = prev[prev.length - 1]
    if (last.kind === 'identifier') {
      return new Set([
        'typeof','void','instanceof','in','return','throw',
        'case','else','new','delete','await','of',
      ]).has(last.raw)
    }
    if (last.kind === 'op') {
      return ![')', ']', '}'].includes(last.raw)
    }
    // after any literal it's division
    return false
  }

  private lexNumber(): JSToken {
    const m = stickyAt(RX_NUMBER, this.src, this.pos)
    if (!m || m[0].length === 0)
      throw new JSLexError('Invalid number literal', this.pos, this.src)
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
    if (raw === 'true' || raw === 'false')
      return { kind: 'boolean', raw, start, end: this.pos }
    if (raw === 'null')
      return { kind: 'null', raw, start, end: this.pos }
    if (raw === 'undefined')
      return { kind: 'undefined', raw, start, end: this.pos }
    return { kind: 'identifier', raw, start, end: this.pos }
  }

  private lexRegex(): JSToken {
    const start = this.pos++  // skip /
    let inClass = false
    while (this.pos < this.src.length) {
      const c = this.src[this.pos++]
      if (c === '\\') { this.pos++ }
      else if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) {
        while (this.pos < this.src.length && /[gimsuyv]/.test(this.src[this.pos]))
          this.pos++
        return { kind: 'regex', raw: this.src.slice(start, this.pos), start, end: this.pos }
      } else if (c === '\n') {
        throw new JSLexError('Unterminated regex literal', start, this.src)
      }
    }
    throw new JSLexError('Unterminated regex literal', start, this.src)
  }

  private lexTemplate(): JSToken {
    const start = this.pos++  // skip `
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
        this.pos += 2  // skip ${
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
      if (ws) { this.pos += ws[0].length; continue }
      if (this.pos >= this.src.length) break
      const c = this.src[this.pos]
      if (c === '}' && depth === 0) { this.pos++; return tokens }
      // Read the next token normally (template literals nest recursively)
      const ch2 = c
      let tok: JSToken
      if (ch2 === '`') tok = this.lexTemplate()
      else if (/\d/.test(ch2) || (ch2 === '.' && /\d/.test(this.src[this.pos + 1] ?? '')))
        tok = this.lexNumber()
      else if (ch2 === '"' || ch2 === "'") tok = this.lexString()
      else if (/[a-zA-Z_$]/.test(ch2)) tok = this.lexIdent()
      else tok = this.lexOp()
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

export function cookTemplate(raw: string): string | null {
  try {
    return raw
      .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
      .replace(/\\`/g, '`').replace(/\\\\/g, '\\').replace(/\\\$/g, '$')
      .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/\\u([\da-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\x([\da-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\0(?!\d)/g, '\0')
      .replace(/\\(.)/g, (_, c) => c)
  } catch {
    return null
  }
}