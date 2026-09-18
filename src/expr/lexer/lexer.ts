import {
  CC_BACKSLASH,
  CC_BACKTICK,
  CC_DOLLAR,
  CC_DOT,
  CC_CR,
  CC_DOUBLE_QUOTE,
  CC_LEFT_BRACE,
  CC_LEFT_BRACKET,
  CC_LF,
  CC_RIGHT_BRACE,
  CC_RIGHT_BRACKET,
  CC_RIGHT_PAREN,
  CC_SINGLE_QUOTE,
  CC_SLASH,
  isDecimalDigitCode,
  isIdentifierPartCode,
  isIdentifierStartCode,
  isLineTerminatorCode,
  isRegexFlagCode,
} from './char-codes.js'
import { compileNumberPolicy, isBigIntLiteral, scanNumber, type NumberPolicy } from './number.js'
import { scanOperatorLength } from './operators.js'
import { cookTemplate } from './template.js'
import { skipTrivia } from './trivia.js'
import {
  JSLexError,
  type JSLexerOptions,
  type JSLexerRule,
  type JSToken,
  type JSTokenKind,
  type TemplateQuasi,
} from './types.js'

const EMPTY_RULES: readonly JSLexerRule[] = []

export class JSLexer {
  private pos = 0
  private readonly includeRaw: boolean
  private readonly rules: readonly JSLexerRule[]
  private readonly numberPolicy: NumberPolicy

  constructor(
    private readonly src: string,
    options: Readonly<JSLexerOptions> = {},
  ) {
    this.includeRaw = options.raw ?? false
    this.rules = options.rules ?? EMPTY_RULES
    this.numberPolicy = compileNumberPolicy(options.numbers)
  }

  get position(): number {
    return this.pos
  }

  tokenize(): JSToken[] {
    const tokens: JSToken[] = []
    while (this.pos < this.src.length) {
      this.pos = skipTrivia(this.src, this.pos)
      if (this.pos >= this.src.length) break
      tokens.push(this.lexToken(tokens))
    }
    return tokens
  }

  private lexToken(prev: JSToken[]): JSToken {
    const rules = this.rules
    for (let index = 0; index < rules.length; index++) {
      const rule = rules[index]
      if (rule.match.call(this, this.src, this.pos, prev)) {
        return this.commitRuleToken(rule.advance.call(this, this.src, this.pos, prev), this.pos)
      }
    }

    const code = this.src.charCodeAt(this.pos)
    if (code === CC_BACKTICK) return this.lexTemplate()
    if (code === CC_SLASH && this.isRegexCtx(prev)) return this.lexRegex()
    if (
      isDecimalDigitCode(code) ||
      (code === CC_DOT && isDecimalDigitCode(this.src.charCodeAt(this.pos + 1)))
    ) {
      return this.lexNumber()
    }
    if (code === CC_DOUBLE_QUOTE || code === CC_SINGLE_QUOTE) return this.lexString()
    if (isIdentifierStartCode(code)) return this.lexIdent()
    return this.lexOp()
  }

  private commitRuleToken(token: JSToken, start: number): JSToken {
    if (
      token.start !== start ||
      !Number.isInteger(token.end) ||
      token.end <= start ||
      token.end > this.src.length ||
      typeof token.value !== 'string'
    ) {
      throw new TypeError('Lexer rule returned an invalid token range or value')
    }

    this.pos = token.end
    const sourceRaw = this.src.slice(token.start, token.end)

    if (this.includeRaw) {
      if (token.raw === sourceRaw) return token
      return { ...token, raw: sourceRaw }
    }

    if (token.raw === undefined) return token
    const { raw: _raw, ...withoutRaw } = token
    return withoutRaw
  }

  private isRegexCtx(prev: JSToken[]): boolean {
    if (prev.length === 0) return true
    const last = prev[prev.length - 1]
    if (last.kind === 'identifier') return isRegexContextKeyword(last.value)
    if (last.kind !== 'op') return false

    if (last.value.length !== 1) return true
    const code = last.value.charCodeAt(0)
    return code !== CC_RIGHT_PAREN && code !== CC_RIGHT_BRACKET && code !== CC_RIGHT_BRACE
  }

  private lexNumber(): JSToken {
    const start = this.pos
    const value = scanNumber(this.src, start, this.numberPolicy)
    this.pos += value.length
    return this.makeToken(isBigIntLiteral(value) ? 'bigint' : 'number', value, start, this.pos)
  }

  private lexString(): JSToken {
    const start = this.pos
    const quote = this.src.charCodeAt(this.pos++)

    while (this.pos < this.src.length) {
      const code = this.src.charCodeAt(this.pos++)
      if (code === quote) {
        const value = this.src.slice(start, this.pos)
        return this.makeToken('string', value, start, this.pos)
      }

      if (isLineTerminatorCode(code)) {
        throw new JSLexError('Unterminated string literal', start, this.src)
      }

      if (code !== CC_BACKSLASH) continue
      if (this.pos >= this.src.length) break

      const escaped = this.src.charCodeAt(this.pos)
      if (escaped === CC_CR && this.src.charCodeAt(this.pos + 1) === CC_LF) {
        this.pos += 2
      } else {
        this.pos++
      }
    }

    throw new JSLexError('Unterminated string literal', start, this.src)
  }

  private lexIdent(): JSToken {
    const start = this.pos++
    while (this.pos < this.src.length && isIdentifierPartCode(this.src.charCodeAt(this.pos))) {
      this.pos++
    }

    const value = this.src.slice(start, this.pos)
    if (value === 'true' || value === 'false') {
      return this.makeToken('boolean', value, start, this.pos)
    }
    if (value === 'null') return this.makeToken('null', value, start, this.pos)
    if (value === 'undefined') return this.makeToken('undefined', value, start, this.pos)
    return this.makeToken('identifier', value, start, this.pos)
  }

  private lexRegex(): JSToken {
    const start = this.pos++
    let inClass = false

    while (this.pos < this.src.length) {
      const code = this.src.charCodeAt(this.pos++)
      if (code === CC_BACKSLASH) {
        if (this.pos >= this.src.length || isLineTerminatorCode(this.src.charCodeAt(this.pos))) {
          throw new JSLexError('Unterminated regex literal', start, this.src)
        }
        this.pos++
        continue
      }

      if (code === CC_LEFT_BRACKET) {
        inClass = true
        continue
      }
      if (code === CC_RIGHT_BRACKET) {
        inClass = false
        continue
      }
      if (code === CC_SLASH && !inClass) {
        while (this.pos < this.src.length && isRegexFlagCode(this.src.charCodeAt(this.pos))) {
          this.pos++
        }
        const value = this.src.slice(start, this.pos)
        return this.makeToken('regex', value, start, this.pos)
      }
      if (isLineTerminatorCode(code)) {
        throw new JSLexError('Unterminated regex literal', start, this.src)
      }
    }

    throw new JSLexError('Unterminated regex literal', start, this.src)
  }

  private lexTemplate(): JSToken {
    const start = this.pos++
    const quasis: TemplateQuasi[] = []
    const exprTokens: JSToken[][] = []
    let quasiStart = this.pos

    while (this.pos < this.src.length) {
      const code = this.src.charCodeAt(this.pos)
      if (code === CC_BACKSLASH) {
        this.pos += 2
        continue
      }

      if (code === CC_BACKTICK) {
        const raw = this.src.slice(quasiStart, this.pos)
        this.pos++
        quasis.push({ raw, cooked: cookTemplate(raw) })
        const value = this.src.slice(start, this.pos)
        return this.makeToken('template', value, start, this.pos, { quasis, exprTokens })
      }

      if (code === CC_DOLLAR && this.src.charCodeAt(this.pos + 1) === CC_LEFT_BRACE) {
        const raw = this.src.slice(quasiStart, this.pos)
        quasis.push({ raw, cooked: cookTemplate(raw) })
        this.pos += 2
        exprTokens.push(this.lexTemplateExpr())
        quasiStart = this.pos
        continue
      }

      this.pos++
    }

    throw new JSLexError('Unterminated template literal', start, this.src)
  }

  private lexTemplateExpr(): JSToken[] {
    const tokens: JSToken[] = []
    let depth = 0

    while (this.pos < this.src.length) {
      this.pos = skipTrivia(this.src, this.pos)
      if (this.pos >= this.src.length) break

      if (this.src.charCodeAt(this.pos) === CC_RIGHT_BRACE && depth === 0) {
        this.pos++
        return tokens
      }

      const token = this.lexToken(tokens)
      if (token.kind === 'op' && token.value.length === 1) {
        const code = token.value.charCodeAt(0)
        if (code === CC_LEFT_BRACE) depth++
        else if (code === CC_RIGHT_BRACE && depth > 0) depth--
      }
      tokens.push(token)
    }

    throw new JSLexError('Unterminated template expression', this.pos, this.src)
  }

  private lexOp(): JSToken {
    const start = this.pos
    const length = scanOperatorLength(this.src, start)
    if (length === 0) {
      throw new JSLexError(`Unexpected character '${this.src[this.pos]}'`, this.pos, this.src)
    }

    this.pos += length
    const value = this.src.slice(start, this.pos)
    return this.makeToken('op', value, start, this.pos)
  }

  private makeToken(
    kind: JSTokenKind,
    value: string,
    start: number,
    end: number,
    tmpl?: JSToken['tmpl'],
  ): JSToken {
    const token: JSToken = tmpl ? { kind, value, start, end, tmpl } : { kind, value, start, end }
    if (this.includeRaw) token.raw = value
    return token
  }
}

function isRegexContextKeyword(value: string): boolean {
  switch (value) {
    case 'typeof':
    case 'void':
    case 'instanceof':
    case 'in':
    case 'return':
    case 'throw':
    case 'case':
    case 'else':
    case 'new':
    case 'delete':
    case 'await':
    case 'of':
      return true
    default:
      return false
  }
}
