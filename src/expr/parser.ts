import { cookTemplate, JSToken, JSTokenKind } from "./lexer.js"
import { JSExprNode, JSMemberNode, JSCallNode, JSConditionalNode, JSBinaryNode, JSLogicalNode, JSPipelineNode, JSSpreadNode, JSObjectPropNode, JSTemplateNode } from "./node-types.js"


function parseStringValue(raw: string): string {
  // strip quotes and handle escapes
  return cookTemplate(raw.slice(1, -1)) ?? raw.slice(1, -1)
}

export class JSParseError extends Error {
  start?: number
  end?: number
  token?: JSToken

  constructor(message: string, token?: JSToken, src = '') {
    const pos =
      token?.start !== undefined ? ` at position ${token.start}–${token.end}` : ''
    // Source context snippet with pointer
    let snippet = ''
    if (src && token?.start !== undefined) {
      const lo = Math.max(0, token.start - 20)
      const hi = Math.min(src.length, (token.end ?? token.start) + 20)
      const line = src.slice(lo, hi)
      const ptr = ' '.repeat(token.start - lo) + '~'.repeat(Math.max(1, (token.end ?? token.start + 1) - token.start))
      snippet = `\n  ${line}\n  ${ptr}`
    }
    super(message + pos + snippet)
    this.name = 'JSParseError'
    this.start = token?.start
    this.end = token?.end
    this.token = token
  }
}

export interface JSParserOptions {
  allowAwait?: boolean
  allowIn?: boolean
}

// Operator precedence table (higher = tighter binding)
const PREC = {
  COMMA: 1,
  PIPELINE: 3,
  CONDITIONAL: 4,
  NULLCOAL: 5,
  OR: 5,
  AND: 6,
  BITOR: 7,
  BITXOR: 8,
  BITAND: 9,
  EQUALITY: 10,
  RELATIONAL: 11,
  SHIFT: 12,
  ADD: 13,
  MUL: 14,
  EXP: 15,
  UNARY: 16,
  POSTFIX: 17,
} as const

const INFIX_PREC: Record<string, number> = {
  '||': PREC.OR, '??': PREC.NULLCOAL,
  '&&': PREC.AND,
  '|': PREC.BITOR, '^': PREC.BITXOR, '&': PREC.BITAND,
  '==': PREC.EQUALITY, '!=': PREC.EQUALITY,
  '===': PREC.EQUALITY, '!==': PREC.EQUALITY,
  '<': PREC.RELATIONAL, '>': PREC.RELATIONAL,
  '<=': PREC.RELATIONAL, '>=': PREC.RELATIONAL,
  'instanceof': PREC.RELATIONAL,
  '<<': PREC.SHIFT, '>>': PREC.SHIFT, '>>>': PREC.SHIFT,
  '+': PREC.ADD, '-': PREC.ADD,
  '*': PREC.MUL, '/': PREC.MUL, '%': PREC.MUL,
  '**': PREC.EXP,  // right-assoc
  '|>': PREC.PIPELINE,  // right-assoc (Hack-style)
}

const RIGHT_ASSOC = new Set(['**'])

export class JSExpressionParser {
  private pos = 0
  private readonly src: string

  constructor(
    private readonly tokens: JSToken[],
    private readonly opts: JSParserOptions = {},
    src = ''
  ) {
    this.src = src
  }

  parse(): JSExprNode {
    if (this.tokens.length === 0)
      throw new JSParseError('Empty expression')
    const node = this.parseExpr(0)
    if (this.pos < this.tokens.length) {
      const t = this.peek()!
      throw new JSParseError(
        `Unexpected token '${t.raw}' after expression`, t, this.src
      )
    }
    return node
  }

  // parseExpr(minPrec) — standard Pratt loop
  private parseExpr(minPrec: number): JSExprNode {
    let left = this.parsePrimary()

    for (; ;) {
      const t = this.peek()
      if (!t) break

      // ── Postfix: member access, call, optional chaining ──────────
      if (t.kind === 'op' && t.raw === '.' && PREC.POSTFIX >= minPrec) {
        this.advance()
        const prop = this.expect('identifier', 'Expected property name after .')
        left = {
          type: 'member', object: left,
          property: { type: 'identifier', name: prop.raw, start: prop.start, end: prop.end },
          computed: false, optional: false, start: t.start, end: prop.end,
        } satisfies JSMemberNode
        continue
      }

      if (t.kind === 'op' && t.raw === '?.' && PREC.POSTFIX >= minPrec) {
        this.advance()
        const next = this.peek()
        if (next?.kind === 'op' && next.raw === '(') {
          this.advance()
          const args = this.parseArgList()
          left = { type: 'call', callee: left, args, optional: true, start: t.start, end: this.lastEnd() } satisfies JSCallNode
        } else if (next?.kind === 'op' && next.raw === '[') {
          this.advance()
          const prop = this.parseExpr(0)
          this.expectOp(']')
          left = { type: 'member', object: left, property: prop, computed: true, optional: true, start: t.start, end: this.lastEnd() } satisfies JSMemberNode
        } else {
          const prop = this.expect('identifier', 'Expected identifier after ?.')
          left = {
            type: 'member', object: left,
            property: { type: 'identifier', name: prop.raw, start: prop.start, end: prop.end },
            computed: false, optional: true, start: t.start, end: prop.end,
          } satisfies JSMemberNode
        }
        continue
      }

      if (t.kind === 'op' && t.raw === '[' && PREC.POSTFIX >= minPrec) {
        this.advance()
        const prop = this.parseExpr(0)
        this.expectOp(']')
        left = { type: 'member', object: left, property: prop, computed: true, optional: false, start: t.start, end: this.lastEnd() } satisfies JSMemberNode
        continue
      }

      if (t.kind === 'op' && t.raw === '(' && PREC.POSTFIX >= minPrec) {
        this.advance()
        const args = this.parseArgList()
        left = { type: 'call', callee: left, args, optional: false, start: t.start, end: this.lastEnd() } satisfies JSCallNode
        continue
      }

      // Tagged template literal
      if (t.kind === 'template' && PREC.POSTFIX >= minPrec) {
        this.advance()
        const tnode = this.buildTemplateNode(t, left)
        left = tnode
        continue
      }

      // ── Conditional (ternary) ──────────────────────────────────────
      if (t.kind === 'op' && t.raw === '?' && PREC.CONDITIONAL >= minPrec) {
        this.advance()
        const consequent = this.parseExpr(0)
        this.expectOp(':', 'Expected `:` in ternary expression')
        const alternate = this.parseExpr(PREC.CONDITIONAL)
        left = { type: 'conditional', test: left, consequent, alternate, start: t.start, end: this.lastEnd() } satisfies JSConditionalNode
        continue
      }

      // ── `in` keyword as infix operator (if enabled) ───────────────
      if (t.kind === 'identifier' && t.raw === 'in' && this.opts.allowIn !== false) {
        const prec = PREC.RELATIONAL
        if (prec < minPrec) break
        this.advance()
        const right = this.parseExpr(prec + 1)
        left = { type: 'binary', operator: 'in', left, right, start: t.start, end: this.lastEnd() } satisfies JSBinaryNode
        continue
      }

      // ── `instanceof` keyword as infix operator ────────────────────
      if (t.kind === 'identifier' && t.raw === 'instanceof') {
        const prec = PREC.RELATIONAL
        if (prec < minPrec) break
        this.advance()
        const right = this.parseExpr(prec + 1)
        left = { type: 'binary', operator: 'instanceof', left, right, start: t.start, end: this.lastEnd() } satisfies JSBinaryNode
        continue
      }

      // ── Regular infix operators ───────────────────────────────────
      if (t.kind === 'op') {
        // Block forbidden assignment operators
        const FORBIDDEN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '&&=', '||=', '??='])
        if (FORBIDDEN.has(t.raw))
          throw new JSParseError(`Assignment operator '${t.raw}' is not allowed in read-only expressions`, t, this.src)

        const prec = INFIX_PREC[t.raw]
        if (prec === undefined || prec < minPrec) break

        this.advance()
        const isRight = RIGHT_ASSOC.has(t.raw)
        const nextMin = isRight ? prec : prec + 1
        const right = this.parseExpr(nextMin)

        // Logical operators get their own node type
        if (t.raw === '&&' || t.raw === '||' || t.raw === '??') {
          left = { type: 'logical', operator: t.raw as any, left, right, start: t.start, end: this.lastEnd() } satisfies JSLogicalNode
        } else if (t.raw === '|>') {
          left = { type: 'pipeline', left, right, start: t.start, end: this.lastEnd() } satisfies JSPipelineNode
        } else {
          left = { type: 'binary', operator: t.raw, left, right, start: t.start, end: this.lastEnd() } satisfies JSBinaryNode
        }
        continue
      }

      break
    }

    return left
  }

  // parsePrimary — null-denotation (prefix position)
  private parsePrimary(): JSExprNode {
    const t = this.peek()
    if (!t) throw new JSParseError('Unexpected end of expression')

    // ── Literals ────────────────────────────────────────────────────
    if (t.kind === 'number') {
      this.advance()
      const raw = t.raw.replace(/_/g, '')  // numeric separators
      return { type: 'literal', value: Number(raw), raw: t.raw, start: t.start, end: t.end }
    }
    if (t.kind === 'bigint') {
      this.advance()
      const raw = t.raw.replace(/_/g, '').slice(0, -1)  // remove 'n'
      return { type: 'literal', value: BigInt(raw.startsWith('0x') || raw.startsWith('0o') || raw.startsWith('0b') ? raw : raw), raw: t.raw, start: t.start, end: t.end }
    }
    if (t.kind === 'string') {
      this.advance()
      return { type: 'literal', value: parseStringValue(t.raw), raw: t.raw, start: t.start, end: t.end }
    }
    if (t.kind === 'boolean') {
      this.advance()
      return { type: 'literal', value: t.raw === 'true', raw: t.raw, start: t.start, end: t.end }
    }
    if (t.kind === 'null') {
      this.advance()
      return { type: 'literal', value: null, raw: t.raw, start: t.start, end: t.end }
    }
    if (t.kind === 'undefined') {
      this.advance()
      return { type: 'literal', value: undefined, raw: t.raw, start: t.start, end: t.end }
    }
    if (t.kind === 'regex') {
      this.advance()
      const lastSlash = t.raw.lastIndexOf('/')
      return { type: 'regex', pattern: t.raw.slice(1, lastSlash), flags: t.raw.slice(lastSlash + 1), raw: t.raw, start: t.start, end: t.end }
    }
    if (t.kind === 'template') {
      this.advance()
      return this.buildTemplateNode(t, null)
    }

    // ── Identifier ──────────────────────────────────────────────────
    if (t.kind === 'identifier') {
      // Forbidden constructs in prefix position
      const FORBIDDEN_IDS = new Set(['new', 'delete', 'yield', 'return', 'throw', 'var', 'let', 'const', 'function', 'class'])
      if (FORBIDDEN_IDS.has(t.raw))
        throw new JSParseError(`'${t.raw}' is not allowed in read-only expressions`, t, this.src)

      // Unary keyword operators
      if (t.raw === 'typeof' || t.raw === 'void') {
        this.advance()
        const operand = this.parseExpr(PREC.UNARY)
        return { type: 'unary', operator: t.raw, operand, start: t.start, end: this.lastEnd() }
      }
      if (t.raw === 'await') {
        if (!this.opts.allowAwait)
          throw new JSParseError("'await' is not enabled in this context (pass { allowAwait: true })", t, this.src)
        this.advance()
        const operand = this.parseExpr(PREC.UNARY)
        return { type: 'unary', operator: 'await', operand, start: t.start, end: this.lastEnd() }
      }

      this.advance()
      return { type: 'identifier', name: t.raw, start: t.start, end: t.end }
    }

    // ── Unary prefix operators ───────────────────────────────────────
    if (t.kind === 'op') {
      if (t.raw === '!' || t.raw === '~' || t.raw === '+' || t.raw === '-') {
        this.advance()
        const operand = this.parseExpr(PREC.EXP)
        return { type: 'unary', operator: t.raw, operand, start: t.start, end: this.lastEnd() }
      }

      // Forbidden prefix operators
      if (t.raw === '++' || t.raw === '--')
        throw new JSParseError(`'${t.raw}' is not allowed in read-only expressions`, t, this.src)

      // Grouping expression
      if (t.raw === '(') {
        this.advance()
        if (this.peek()?.raw === ')') {
          // empty parens only valid as arrow function params, not allowed
          throw new JSParseError('Empty parentheses are not a valid expression', t, this.src)
        }
        const expr = this.parseExpr(0)
        this.expectOp(')')
        return expr
      }

      // Array literal
      if (t.raw === '[') {
        this.advance()
        const elements: Array<JSExprNode | JSSpreadNode | null> = []
        while (this.peek()?.raw !== ']') {
          if (!this.peek()) throw new JSParseError('Unterminated array literal', t, this.src)
          if (this.peek()!.raw === ',') {
            this.advance()
            elements.push(null)  // hole
            continue
          }
          if (this.peek()!.raw === '...') {
            const spread = this.advance()!
            elements.push({ type: 'spread', argument: this.parseExpr(PREC.COMMA + 1), start: spread.start, end: this.lastEnd() })
          } else {
            elements.push(this.parseExpr(PREC.COMMA + 1))
          }
          if (this.peek()?.raw === ',') this.advance()
          else break
        }
        this.expectOp(']', 'Unterminated array literal, expected ]')
        return { type: 'array', elements, start: t.start, end: this.lastEnd() }
      }

      // Object literal
      if (t.raw === '{') {
        this.advance()
        const props: Array<JSObjectPropNode | JSSpreadNode> = []
        while (this.peek()?.raw !== '}') {
          if (!this.peek()) throw new JSParseError('Unterminated object literal', t, this.src)

          // Spread property
          if (this.peek()!.raw === '...') {
            const spread = this.advance()!
            props.push({ type: 'spread', argument: this.parseExpr(PREC.COMMA + 1), start: spread.start, end: this.lastEnd() })
            if (this.peek()?.raw === ',') this.advance()
            continue
          }

          // Computed key: [expr]: value
          if (this.peek()!.raw === '[') {
            const lb = this.advance()!
            const key = this.parseExpr(0)
            this.expectOp(']')
            this.expectOp(':', 'Expected : after computed object key')
            const value = this.parseExpr(PREC.COMMA + 1)
            props.push({ type: 'property', key, value, computed: true, shorthand: false, start: lb.start, end: this.lastEnd() })
          } else {
            // Regular or shorthand key
            const keyTok = this.advance()!
            if (!keyTok) throw new JSParseError('Expected property key', undefined, this.src)
            const key: JSExprNode = (keyTok.kind === 'string')
              ? { type: 'literal', value: parseStringValue(keyTok.raw), raw: keyTok.raw, start: keyTok.start, end: keyTok.end }
              : (keyTok.kind === 'number' || keyTok.kind === 'bigint')
                ? { type: 'literal', value: parseFloat(keyTok.raw.replace(/_/g, '')), raw: keyTok.raw, start: keyTok.start, end: keyTok.end }
                : { type: 'identifier', name: keyTok.raw, start: keyTok.start, end: keyTok.end }

            if (this.peek()?.raw === ':') {
              this.advance()
              const value = this.parseExpr(PREC.COMMA + 1)
              props.push({ type: 'property', key, value, computed: false, shorthand: false, start: keyTok.start, end: this.lastEnd() })
            } else {
              // shorthand {x} — only valid for identifiers
              if (keyTok.kind !== 'identifier')
                throw new JSParseError(`Expected ':' after object key '${keyTok.raw}'`, keyTok, this.src)
              props.push({ type: 'property', key, value: { type: 'identifier', name: keyTok.raw, start: keyTok.start, end: keyTok.end }, computed: false, shorthand: true, start: keyTok.start, end: keyTok.end })
            }
          }
          if (this.peek()?.raw === ',') this.advance()
          else break
        }
        this.expectOp('}', 'Unterminated object literal, expected }')
        return { type: 'object', props, start: t.start, end: this.lastEnd() }
      }
    }

    throw new JSParseError(
      `Unexpected token '${t.raw}'`,
      t,
      this.src
    )
  }

  private parseArgList(): Array<JSExprNode | JSSpreadNode> {
    const args: Array<JSExprNode | JSSpreadNode> = []
    while (this.peek()?.raw !== ')') {
      if (!this.peek()) throw new JSParseError('Unterminated argument list')
      if (this.peek()!.raw === '...') {
        const s = this.advance()!
        args.push({ type: 'spread', argument: this.parseExpr(PREC.COMMA + 1), start: s.start, end: this.lastEnd() })
      } else {
        args.push(this.parseExpr(PREC.COMMA + 1))
      }
      if (this.peek()?.raw === ',') this.advance()
      else break
    }
    this.expectOp(')', 'Unterminated argument list, expected )')
    return args
  }

  private buildTemplateNode(tok: JSToken, tag: JSExprNode | null): JSTemplateNode {
    const data = tok.tmpl!
    const expressions: JSExprNode[] = data.exprTokens.map((exprToks, i) => {
      const p = new JSExpressionParser(exprToks, this.opts, this.src)
      try { return p.parse() }
      catch (e) {
        if (e instanceof JSParseError) throw e
        throw new JSParseError(`Error in template expression #${i + 1}: ${(e as Error).message}`, tok, this.src)
      }
    })
    return {
      type: 'template',
      tag,
      quasis: data.quasis,
      expressions,
      start: tok.start,
      end: tok.end,
    }
  }

  private peek(): JSToken | undefined { return this.tokens[this.pos] }
  private advance(): JSToken | undefined { return this.tokens[this.pos++] }
  private lastEnd(): number { return this.tokens[this.pos - 1]?.end ?? 0 }

  private expect(kind: JSTokenKind, msg?: string): JSToken {
    const t = this.advance()
    if (!t || t.kind !== kind)
      throw new JSParseError(msg ?? `Expected ${kind}, got '${t?.raw ?? 'end of input'}'`, t, this.src)
    return t
  }

  private expectOp(raw: string, msg?: string): JSToken {
    const t = this.advance()
    if (!t || t.raw !== raw)
      throw new JSParseError(
        msg ?? `Expected '${raw}', got '${t?.raw ?? 'end of input'}'`,
        t ?? this.tokens[this.pos - 1],
        this.src
      )
    return t
  }
}