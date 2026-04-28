import { cookTemplate, type JSToken, type JSTokenKind } from './lexer.js'
import type {
  JSArrowFunctionNode,
  JSArrowParameterNode,
  JSBindingArrayNode,
  JSBindingAssignmentNode,
  JSBindingIdentifierNode,
  JSBindingNode,
  JSBindingObjectNode,
  JSBindingPropertyNode,
  JSExprNode,
  JSMemberNode,
  JSCallNode,
  JSConditionalNode,
  JSBinaryNode,
  JSLogicalNode,
  JSPipelineNode,
  JSSpreadNode,
  JSObjectPropNode,
  JSSequenceNode,
  JSTemplateNode,
  JSTopicReferenceNode,
} from './node-types.js'

// #region Parse helpers, errors, and options

function parseStringValue(raw: string): string {
  // strip quotes and handle escapes
  return cookTemplate(raw.slice(1, -1)) ?? raw.slice(1, -1)
}

/** Error raised while parsing tokens into an expression AST. */
export class JSParseError extends Error {
  start?: number
  end?: number
  token?: JSToken

  constructor(message: string, token?: JSToken, src = '') {
    const pos = token?.start !== undefined ? ` at position ${token.start}–${token.end}` : ''
    // Source context snippet with pointer
    let snippet = ''
    if (src && token?.start !== undefined) {
      const lo = Math.max(0, token.start - 20)
      const hi = Math.min(src.length, (token.end ?? token.start) + 20)
      const line = src.slice(lo, hi)
      const ptr =
        ' '.repeat(token.start - lo) +
        '~'.repeat(Math.max(1, (token.end ?? token.start + 1) - token.start))
      snippet = `\n  ${line}\n  ${ptr}`
    }
    super(message + pos + snippet)
    this.name = 'JSParseError'
    this.start = token?.start
    this.end = token?.end
    this.token = token
  }
}

/** Parser feature flags for the expression grammar. */
export interface JSParserOptions {
  allowAwait?: boolean
  allowArrowFunctions?: boolean
  allowIn?: boolean
  allowRegexLiterals?: boolean
  allowTemplateLiterals?: boolean
  allowTaggedTemplates?: boolean
  maxSourceLength?: number
  maxAstNodes?: number
  maxAstDepth?: number
  maxArrayElements?: number
  maxObjectProperties?: number
  maxCallArguments?: number
  maxTemplateExpressions?: number
}

// #endregion

// #region Parser precedence and grammar guards

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
  '||': PREC.OR,
  '??': PREC.NULLCOAL,
  '&&': PREC.AND,
  '|': PREC.BITOR,
  '^': PREC.BITXOR,
  '&': PREC.BITAND,
  '==': PREC.EQUALITY,
  '!=': PREC.EQUALITY,
  '===': PREC.EQUALITY,
  '!==': PREC.EQUALITY,
  '<': PREC.RELATIONAL,
  '>': PREC.RELATIONAL,
  '<=': PREC.RELATIONAL,
  '>=': PREC.RELATIONAL,
  instanceof: PREC.RELATIONAL,
  '<<': PREC.SHIFT,
  '>>': PREC.SHIFT,
  '>>>': PREC.SHIFT,
  '+': PREC.ADD,
  '-': PREC.ADD,
  '*': PREC.MUL,
  '/': PREC.MUL,
  '%': PREC.MUL,
  '**': PREC.EXP, // right-assoc
  '|>': PREC.PIPELINE, // right-assoc (Hack-style)
}

const RIGHT_ASSOC = new Set(['**'])
const FORBIDDEN_ASSIGNMENT_OPERATORS = new Set([
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '**=',
  '&=',
  '|=',
  '^=',
  '<<=',
  '>>=',
  '>>>=',
  '&&=',
  '||=',
  '??=',
])
const FORBIDDEN_PREFIX_IDENTIFIERS = new Set([
  'new',
  'delete',
  'yield',
  'return',
  'throw',
  'var',
  'let',
  'const',
  'function',
  'class',
])
const FORBIDDEN_ARROW_BINDING_IDENTIFIERS = new Set([
  ...FORBIDDEN_PREFIX_IDENTIFIERS,
  'arguments',
  'super',
  'this',
])
const FORBIDDEN_ARROW_REFERENCE_IDENTIFIERS = new Set(['arguments', 'super', 'this'])

// #endregion

// #region Public parser

/** Pratt-style parser that converts tokens into expression AST nodes. */
export class JSExpressionParser {
  private pos = 0
  private readonly parenthesizedNodes = new WeakSet<JSExprNode>()
  private readonly src: string

  constructor(
    private readonly tokens: JSToken[],
    private readonly opts: JSParserOptions = {},
    src = '',
  ) {
    this.src = src
  }

  parse(): JSExprNode {
    if (this.tokens.length === 0) throw new JSParseError('Empty expression')
    const node = this.parseSequenceExpr()
    if (this.pos < this.tokens.length) {
      const t = this.peek()!
      throw new JSParseError(`Unexpected token '${t.raw}' after expression`, t, this.src)
    }
    this.validateTopicUsage(node)
    return node
  }

  private parseSequenceExpr(): JSExprNode {
    let left = this.parseAssignmentExpr()

    while (this.peek()?.kind === 'op' && this.peek()!.raw === ',') {
      this.advance()
      const right = this.parseAssignmentExpr()
      left = {
        type: 'sequence',
        expressions: left.type === 'sequence' ? [...left.expressions, right] : [left, right],
        start: left.start,
        end: this.lastEnd(),
      } satisfies JSSequenceNode
    }

    return left
  }

  private parseAssignmentExpr(): JSExprNode {
    if (this.isArrowFunctionStart()) return this.parseArrowFunction()
    return this.parsePipeExpr()
  }

  private parsePipeExpr(): JSExprNode {
    let left = this.parseConditionalExpr()

    while (this.peek()?.kind === 'op' && this.peek()!.raw === '|>') {
      const pipe = this.advance()!
      const right = this.parseAssignmentExpr()
      left = {
        type: 'pipeline',
        left,
        right,
        start: left.start ?? pipe.start,
        end: this.lastEnd(),
      } satisfies JSPipelineNode
    }

    return left
  }

  private parseConditionalExpr(): JSExprNode {
    const test = this.parseShortCircuitExpr()
    if (this.peek()?.kind !== 'op' || this.peek()!.raw !== '?') return test

    this.advance()
    const consequent = this.parseAssignmentExpr()
    this.expectOp(':', 'Expected `:` in ternary expression')
    const alternate = this.parseAssignmentExpr()

    return {
      type: 'conditional',
      test,
      consequent,
      alternate,
      start: test.start,
      end: this.lastEnd(),
    } satisfies JSConditionalNode
  }

  private parseShortCircuitExpr(): JSExprNode {
    return this.parseExpr(PREC.NULLCOAL)
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
          type: 'member',
          object: left,
          property: { type: 'identifier', name: prop.raw, start: prop.start, end: prop.end },
          computed: false,
          optional: false,
          start: t.start,
          end: prop.end,
        } satisfies JSMemberNode
        continue
      }

      if (t.kind === 'op' && t.raw === '?.' && PREC.POSTFIX >= minPrec) {
        this.advance()
        const next = this.peek()
        if (next?.kind === 'op' && next.raw === '(') {
          this.advance()
          const args = this.parseArgList()
          left = {
            type: 'call',
            callee: left,
            args,
            optional: true,
            start: t.start,
            end: this.lastEnd(),
          } satisfies JSCallNode
        } else if (next?.kind === 'op' && next.raw === '[') {
          this.advance()
          const prop = this.parseSequenceExpr()
          this.expectOp(']')
          left = {
            type: 'member',
            object: left,
            property: prop,
            computed: true,
            optional: true,
            start: t.start,
            end: this.lastEnd(),
          } satisfies JSMemberNode
        } else {
          const prop = this.expect('identifier', 'Expected identifier after ?.')
          left = {
            type: 'member',
            object: left,
            property: { type: 'identifier', name: prop.raw, start: prop.start, end: prop.end },
            computed: false,
            optional: true,
            start: t.start,
            end: prop.end,
          } satisfies JSMemberNode
        }
        continue
      }

      if (t.kind === 'op' && t.raw === '[' && PREC.POSTFIX >= minPrec) {
        this.advance()
        const prop = this.parseSequenceExpr()
        this.expectOp(']')
        left = {
          type: 'member',
          object: left,
          property: prop,
          computed: true,
          optional: false,
          start: t.start,
          end: this.lastEnd(),
        } satisfies JSMemberNode
        continue
      }

      if (t.kind === 'op' && t.raw === '(' && PREC.POSTFIX >= minPrec) {
        this.advance()
        const args = this.parseArgList()
        left = {
          type: 'call',
          callee: left,
          args,
          optional: false,
          start: t.start,
          end: this.lastEnd(),
        } satisfies JSCallNode
        continue
      }

      // Tagged template literal
      if (t.kind === 'template' && PREC.POSTFIX >= minPrec) {
        if (this.opts.allowTaggedTemplates === false) {
          throw new JSParseError(
            'Tagged template literals are not enabled in this context (pass { allowTaggedTemplates: true })',
            t,
            this.src,
          )
        }
        this.advance()
        const tnode = this.buildTemplateNode(t, left)
        left = tnode
        continue
      }

      // ── `in` keyword as infix operator (if enabled) ───────────────
      if (t.kind === 'identifier' && t.raw === 'in' && this.opts.allowIn !== false) {
        const prec = PREC.RELATIONAL
        if (prec < minPrec) break
        this.advance()
        const right = this.parseExpr(prec + 1)
        left = {
          type: 'binary',
          operator: 'in',
          left,
          right,
          start: t.start,
          end: this.lastEnd(),
        } satisfies JSBinaryNode
        continue
      }

      // ── `instanceof` keyword as infix operator ────────────────────
      if (t.kind === 'identifier' && t.raw === 'instanceof') {
        const prec = PREC.RELATIONAL
        if (prec < minPrec) break
        this.advance()
        const right = this.parseExpr(prec + 1)
        left = {
          type: 'binary',
          operator: 'instanceof',
          left,
          right,
          start: t.start,
          end: this.lastEnd(),
        } satisfies JSBinaryNode
        continue
      }

      // ── Regular infix operators ───────────────────────────────────
      if (t.kind === 'op') {
        // Block forbidden assignment operators
        if (FORBIDDEN_ASSIGNMENT_OPERATORS.has(t.raw))
          throw new JSParseError(
            `Assignment operator '${t.raw}' is not allowed in read-only expressions`,
            t,
            this.src,
          )

        const prec = INFIX_PREC[t.raw]
        if (prec === undefined || prec < minPrec) break

        this.advance()
        const isRight = RIGHT_ASSOC.has(t.raw)
        const nextMin = isRight ? prec : prec + 1
        const right = this.parseExpr(nextMin)

        // Logical operators get their own node type
        if (t.raw === '&&' || t.raw === '||' || t.raw === '??') {
          this.assertValidLogicalMixing(t.raw, left, right, t)
          left = {
            type: 'logical',
            operator: t.raw as any,
            left,
            right,
            start: t.start,
            end: this.lastEnd(),
          } satisfies JSLogicalNode
        } else {
          left = {
            type: 'binary',
            operator: t.raw,
            left,
            right,
            start: t.start,
            end: this.lastEnd(),
          } satisfies JSBinaryNode
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
      const raw = t.raw.replace(/_/g, '') // numeric separators
      return { type: 'literal', value: Number(raw), raw: t.raw, start: t.start, end: t.end }
    }
    if (t.kind === 'bigint') {
      this.advance()
      const raw = t.raw.replace(/_/g, '').slice(0, -1) // remove 'n'
      return {
        type: 'literal',
        value: BigInt(
          raw.startsWith('0x') || raw.startsWith('0o') || raw.startsWith('0b') ? raw : raw,
        ),
        raw: t.raw,
        start: t.start,
        end: t.end,
      }
    }
    if (t.kind === 'string') {
      this.advance()
      return {
        type: 'literal',
        value: parseStringValue(t.raw),
        raw: t.raw,
        start: t.start,
        end: t.end,
      }
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
      if (this.opts.allowRegexLiterals === false) {
        throw new JSParseError(
          'Regular expression literals are not enabled in this context (pass { allowRegexLiterals: true })',
          t,
          this.src,
        )
      }
      this.advance()
      const lastSlash = t.raw.lastIndexOf('/')
      return {
        type: 'regex',
        pattern: t.raw.slice(1, lastSlash),
        flags: t.raw.slice(lastSlash + 1),
        raw: t.raw,
        start: t.start,
        end: t.end,
      }
    }
    if (t.kind === 'template') {
      if (this.opts.allowTemplateLiterals === false) {
        throw new JSParseError(
          'Template literals are not enabled in this context (pass { allowTemplateLiterals: true })',
          t,
          this.src,
        )
      }
      this.advance()
      return this.buildTemplateNode(t, null)
    }

    // ── Identifier ──────────────────────────────────────────────────
    if (t.kind === 'identifier') {
      // Forbidden constructs in prefix position
      if (FORBIDDEN_PREFIX_IDENTIFIERS.has(t.raw))
        throw new JSParseError(`'${t.raw}' is not allowed in read-only expressions`, t, this.src)

      // Unary keyword operators
      if (t.raw === 'typeof' || t.raw === 'void') {
        this.advance()
        const operand = this.parseExpr(PREC.UNARY)
        return { type: 'unary', operator: t.raw, operand, start: t.start, end: this.lastEnd() }
      }
      if (t.raw === 'await') {
        if (!this.opts.allowAwait)
          throw new JSParseError(
            "'await' is not enabled in this context (pass { allowAwait: true })",
            t,
            this.src,
          )
        this.advance()
        const operand = this.parseExpr(PREC.UNARY)
        return { type: 'unary', operator: 'await', operand, start: t.start, end: this.lastEnd() }
      }

      this.advance()
      return { type: 'identifier', name: t.raw, start: t.start, end: t.end }
    }

    // ── Unary prefix operators ───────────────────────────────────────
    if (t.kind === 'op') {
      if (t.raw === '%') {
        this.advance()
        return { type: 'topic', start: t.start, end: t.end } satisfies JSTopicReferenceNode
      }

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
        const expr = this.parseSequenceExpr()
        this.expectOp(')')
        this.parenthesizedNodes.add(expr)
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
            elements.push(null) // hole
            continue
          }
          if (this.peek()!.raw === '...') {
            const spread = this.advance()!
            elements.push({
              type: 'spread',
              argument: this.parseAssignmentExpr(),
              start: spread.start,
              end: this.lastEnd(),
            })
          } else {
            elements.push(this.parseAssignmentExpr())
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
            props.push({
              type: 'spread',
              argument: this.parseAssignmentExpr(),
              start: spread.start,
              end: this.lastEnd(),
            })
            if (this.peek()?.raw === ',') this.advance()
            continue
          }

          // Computed key: [expr]: value
          if (this.peek()!.raw === '[') {
            const lb = this.advance()!
            const key = this.parseSequenceExpr()
            this.expectOp(']')
            this.expectOp(':', 'Expected : after computed object key')
            const value = this.parseAssignmentExpr()
            props.push({
              type: 'property',
              key,
              value,
              computed: true,
              shorthand: false,
              start: lb.start,
              end: this.lastEnd(),
            })
          } else {
            // Regular or shorthand key
            const keyTok = this.advance()!
            if (!keyTok) throw new JSParseError('Expected property key', undefined, this.src)
            const key: JSExprNode =
              keyTok.kind === 'string'
                ? {
                  type: 'literal',
                  value: parseStringValue(keyTok.raw),
                  raw: keyTok.raw,
                  start: keyTok.start,
                  end: keyTok.end,
                }
                : keyTok.kind === 'number' || keyTok.kind === 'bigint'
                  ? {
                    type: 'literal',
                    value: parseFloat(keyTok.raw.replace(/_/g, '')),
                    raw: keyTok.raw,
                    start: keyTok.start,
                    end: keyTok.end,
                  }
                  : { type: 'identifier', name: keyTok.raw, start: keyTok.start, end: keyTok.end }

            if (this.peek()?.raw === ':') {
              this.advance()
              const value = this.parseAssignmentExpr()
              props.push({
                type: 'property',
                key,
                value,
                computed: false,
                shorthand: false,
                start: keyTok.start,
                end: this.lastEnd(),
              })
            } else {
              // shorthand {x} — only valid for identifiers
              if (keyTok.kind !== 'identifier')
                throw new JSParseError(
                  `Expected ':' after object key '${keyTok.raw}'`,
                  keyTok,
                  this.src,
                )
              props.push({
                type: 'property',
                key,
                value: {
                  type: 'identifier',
                  name: keyTok.raw,
                  start: keyTok.start,
                  end: keyTok.end,
                },
                computed: false,
                shorthand: true,
                start: keyTok.start,
                end: keyTok.end,
              })
            }
          }
          if (this.peek()?.raw === ',') this.advance()
          else break
        }
        this.expectOp('}', 'Unterminated object literal, expected }')
        return { type: 'object', props, start: t.start, end: this.lastEnd() }
      }
    }

    throw new JSParseError(`Unexpected token '${t.raw}'`, t, this.src)
  }

  private parseArgList(): Array<JSExprNode | JSSpreadNode> {
    const args: Array<JSExprNode | JSSpreadNode> = []
    while (this.peek()?.raw !== ')') {
      if (!this.peek()) throw new JSParseError('Unterminated argument list')
      if (this.peek()!.raw === '...') {
        const s = this.advance()!
        args.push({
          type: 'spread',
          argument: this.parseAssignmentExpr(),
          start: s.start,
          end: this.lastEnd(),
        })
      } else {
        args.push(this.parseAssignmentExpr())
      }
      if (this.peek()?.raw === ',') this.advance()
      else break
    }
    this.expectOp(')', 'Unterminated argument list, expected )')
    return args
  }

  private buildTemplateNode(tok: JSToken, tag: JSExprNode | null): JSTemplateNode {
    const data = tok.tmpl!
    if (!tag && data.quasis.some((quasi) => quasi.cooked === null)) {
      throw new JSParseError('Invalid escape sequence in template literal', tok, this.src)
    }

    const expressions: JSExprNode[] = data.exprTokens.map((exprTokens, i) => {
      const p = new JSExpressionParser(exprTokens, this.opts, this.src)
      try {
        return p.parse()
      } catch (e) {
        if (e instanceof JSParseError) throw e
        throw new JSParseError(
          `Error in template expression #${i + 1}: ${(e as Error).message}`,
          tok,
          this.src,
        )
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

  private isArrowFunctionStart(): boolean {
    const start = this.peek()
    if (!start) return false

    if (start.kind === 'identifier') {
      const arrow = this.tokens[this.pos + 1]
      return (
        arrow?.kind === 'op' &&
        arrow.raw === '=>' &&
        !this.hasLineTerminatorBetween(start.end, arrow.start)
      )
    }

    if (start.kind === 'op' && start.raw === '(') {
      const closeIndex = this.findMatchingParenIndex(this.pos)
      if (closeIndex < 0) return false

      const close = this.tokens[closeIndex]
      const arrow = this.tokens[closeIndex + 1]
      return (
        close?.kind === 'op' &&
        close.raw === ')' &&
        arrow?.kind === 'op' &&
        arrow.raw === '=>' &&
        !this.hasLineTerminatorBetween(close.end, arrow.start)
      )
    }

    return false
  }

  private parseArrowFunction(): JSArrowFunctionNode {
    if (this.opts.allowArrowFunctions === false) {
      throw new JSParseError(
        'Arrow functions are not enabled in this context',
        this.peek(),
        this.src,
      )
    }

    const start = this.peek()!
    let params: JSArrowParameterNode[]

    if (start.kind === 'identifier') {
      const param = this.bindingIdentifierFromToken(this.advance()!)
      this.expectOp('=>', 'Expected `=>` after arrow parameter')
      params = [
        {
          type: 'parameter',
          binding: param,
          rest: false,
          start: param.start,
          end: param.end,
        },
      ]
    } else {
      params = this.parseArrowParameterList()
      this.expectOp('=>', 'Expected `=>` after arrow parameters')
    }

    if (this.peek()?.kind === 'op' && this.peek()!.raw === '{') {
      throw new JSParseError(
        'Arrow functions with block bodies are not supported in this context',
        this.peek(),
        this.src,
      )
    }

    const body = this.parseAssignmentExpr()
    const node = {
      type: 'arrow-function',
      params,
      body,
      start: start.start,
      end: this.lastEnd(),
    } satisfies JSArrowFunctionNode

    this.validateArrowFunction(node)
    return node
  }

  private parseArrowParameterList(): JSArrowParameterNode[] {
    const open = this.expectOp('(')
    const params: JSArrowParameterNode[] = []

    if (this.peek()?.kind === 'op' && this.peek()!.raw === ')') {
      this.advance()
      return params
    }

    for (; ;) {
      const start = this.peek()
      if (!start) throw new JSParseError('Unterminated arrow parameter list', open, this.src)

      let rest = false
      let binding: JSBindingNode

      if (start.kind === 'op' && start.raw === '...') {
        rest = true
        this.advance()
        binding = this.parseBindingPattern()
      } else {
        binding = this.parseBindingElement()
      }

      params.push({
        type: 'parameter',
        binding,
        rest,
        start: start.start,
        end: this.lastEnd(),
      })

      if (rest) break
      if (this.peek()?.kind !== 'op' || this.peek()!.raw !== ',') break
      this.advance()
      if (this.peek()?.kind === 'op' && this.peek()!.raw === ')') break
    }

    this.expectOp(')', 'Expected `)` after arrow parameters')
    return params
  }

  private parseBindingElement(): JSBindingNode {
    const binding = this.parseBindingPattern()
    if (this.peek()?.kind === 'op' && this.peek()!.raw === '=') {
      this.advance()
      return {
        type: 'binding-assignment',
        left: binding,
        defaultValue: this.parseAssignmentExpr(),
        start: binding.start,
        end: this.lastEnd(),
      } satisfies JSBindingAssignmentNode
    }
    return binding
  }

  private parseBindingPattern(): JSBindingNode {
    const t = this.peek()
    if (!t) throw new JSParseError('Unexpected end of arrow parameter list', undefined, this.src)

    if (t.kind === 'identifier') {
      return this.bindingIdentifierFromToken(this.advance()!)
    }
    if (t.kind === 'op' && t.raw === '[') return this.parseBindingArrayPattern()
    if (t.kind === 'op' && t.raw === '{') return this.parseBindingObjectPattern()

    throw new JSParseError(`Unexpected token '${t.raw}' in arrow parameter list`, t, this.src)
  }

  private parseBindingArrayPattern(): JSBindingArrayNode {
    const open = this.expectOp('[')
    const elements: Array<JSBindingNode | null> = []
    let rest: JSBindingNode | null = null

    while (this.peek()?.kind !== 'op' || this.peek()!.raw !== ']') {
      if (!this.peek()) throw new JSParseError('Unterminated array binding pattern', open, this.src)
      if (this.peek()!.kind === 'op' && this.peek()!.raw === ',') {
        this.advance()
        elements.push(null)
        continue
      }
      if (this.peek()!.kind === 'op' && this.peek()!.raw === '...') {
        this.advance()
        rest = this.parseBindingPattern()
        break
      }

      elements.push(this.parseBindingElement())
      if (this.peek()?.kind === 'op' && this.peek()!.raw === ',') this.advance()
      else break
    }

    this.expectOp(']', 'Expected `]` after array binding pattern')
    return {
      type: 'binding-array',
      elements,
      rest,
      start: open.start,
      end: this.lastEnd(),
    }
  }

  private parseBindingObjectPattern(): JSBindingObjectNode {
    const open = this.expectOp('{')
    const properties: JSBindingPropertyNode[] = []
    let rest: JSBindingIdentifierNode | null = null

    while (this.peek()?.kind !== 'op' || this.peek()!.raw !== '}') {
      if (!this.peek())
        throw new JSParseError('Unterminated object binding pattern', open, this.src)

      if (this.peek()!.kind === 'op' && this.peek()!.raw === '...') {
        const spread = this.advance()!
        rest = this.bindingIdentifierFromToken(
          this.expect('identifier', 'Expected identifier after object rest operator'),
        )
        rest.start = spread.start
        rest.end = this.lastEnd()
        break
      }

      if (this.peek()!.kind === 'op' && this.peek()!.raw === '[') {
        const lb = this.advance()!
        const key = this.parseSequenceExpr()
        this.expectOp(']')
        this.expectOp(':', 'Expected `:` after computed binding key')
        const value = this.parseBindingElement()
        properties.push({
          type: 'binding-property',
          key,
          value,
          computed: true,
          shorthand: false,
          start: lb.start,
          end: this.lastEnd(),
        })
      } else {
        const keyTok = this.advance()!
        const key = this.tokenToPropertyKeyNode(keyTok)

        if (this.peek()?.kind === 'op' && this.peek()!.raw === ':') {
          this.advance()
          properties.push({
            type: 'binding-property',
            key,
            value: this.parseBindingElement(),
            computed: false,
            shorthand: false,
            start: keyTok.start,
            end: this.lastEnd(),
          })
        } else {
          if (keyTok.kind !== 'identifier') {
            throw new JSParseError(
              `Expected ':' after binding key '${keyTok.raw}'`,
              keyTok,
              this.src,
            )
          }

          const value = this.bindingIdentifierFromToken(keyTok)
          let binding: JSBindingNode = value

          if (this.peek()?.kind === 'op' && this.peek()!.raw === '=') {
            this.advance()
            binding = {
              type: 'binding-assignment',
              left: value,
              defaultValue: this.parseAssignmentExpr(),
              start: value.start,
              end: this.lastEnd(),
            } satisfies JSBindingAssignmentNode
          }

          properties.push({
            type: 'binding-property',
            key,
            value: binding,
            computed: false,
            shorthand: true,
            start: keyTok.start,
            end: this.lastEnd(),
          })
        }
      }

      if (this.peek()?.kind === 'op' && this.peek()!.raw === ',') this.advance()
      else break
    }

    this.expectOp('}', 'Expected `}` after object binding pattern')
    return {
      type: 'binding-object',
      properties,
      rest,
      start: open.start,
      end: this.lastEnd(),
    }
  }

  private bindingIdentifierFromToken(token: JSToken): JSBindingIdentifierNode {
    if (token.kind !== 'identifier') {
      throw new JSParseError('Expected parameter name', token, this.src)
    }
    if (FORBIDDEN_ARROW_BINDING_IDENTIFIERS.has(token.raw)) {
      throw new JSParseError(`'${token.raw}' is not allowed in arrow parameters`, token, this.src)
    }
    return { type: 'binding-identifier', name: token.raw, start: token.start, end: token.end }
  }

  private tokenToPropertyKeyNode(token: JSToken): JSExprNode {
    if (token.kind === 'string') {
      return {
        type: 'literal',
        value: parseStringValue(token.raw),
        raw: token.raw,
        start: token.start,
        end: token.end,
      }
    }
    if (token.kind === 'number' || token.kind === 'bigint') {
      return {
        type: 'literal',
        value: parseFloat(token.raw.replace(/_/g, '').replace(/n$/, '')),
        raw: token.raw,
        start: token.start,
        end: token.end,
      }
    }
    return { type: 'identifier', name: token.raw, start: token.start, end: token.end }
  }

  private validateArrowFunction(node: JSArrowFunctionNode): void {
    const boundNames = new Set<string>()

    for (const param of node.params) {
      for (const name of this.collectBoundNames(param.binding)) {
        if (boundNames.has(name)) {
          throw new JSParseError(
            `Duplicate parameter name '${name}' in arrow function`,
            undefined,
            this.src,
          )
        }
        boundNames.add(name)
      }
      this.validateBindingArrowReferences(param.binding)
    }

    this.validateArrowReferences(node.body)
  }

  private collectBoundNames(binding: JSBindingNode): string[] {
    switch (binding.type) {
      case 'binding-identifier':
        return [binding.name]
      case 'binding-assignment':
        return this.collectBoundNames(binding.left)
      case 'binding-array': {
        const names: string[] = []
        for (const element of binding.elements) {
          if (element) names.push(...this.collectBoundNames(element))
        }
        if (binding.rest) names.push(...this.collectBoundNames(binding.rest))
        return names
      }
      case 'binding-object': {
        const names: string[] = []
        for (const prop of binding.properties) names.push(...this.collectBoundNames(prop.value))
        if (binding.rest) names.push(binding.rest.name)
        return names
      }
    }
  }

  private validateBindingArrowReferences(binding: JSBindingNode): void {
    switch (binding.type) {
      case 'binding-identifier':
        return
      case 'binding-assignment':
        this.validateBindingArrowReferences(binding.left)
        this.validateArrowReferences(binding.defaultValue)
        return
      case 'binding-array':
        for (const element of binding.elements) {
          if (element) this.validateBindingArrowReferences(element)
        }
        if (binding.rest) this.validateBindingArrowReferences(binding.rest)
        return
      case 'binding-object':
        for (const prop of binding.properties) {
          if (prop.computed) this.validateArrowReferences(prop.key)
          this.validateBindingArrowReferences(prop.value)
        }
        return
    }
  }

  private validateArrowReferences(node: JSExprNode): void {
    switch (node.type) {
      case 'literal':
      case 'regex':
      case 'topic':
        return
      case 'identifier':
        if (FORBIDDEN_ARROW_REFERENCE_IDENTIFIERS.has(node.name)) {
          throw new JSParseError(
            `Arrow functions do not support '${node.name}' in this context`,
            undefined,
            this.src,
          )
        }
        return
      case 'arrow-function':
        return
      case 'unary':
        this.validateArrowReferences(node.operand)
        return
      case 'binary':
      case 'logical':
        this.validateArrowReferences(node.left)
        this.validateArrowReferences(node.right)
        return
      case 'conditional':
        this.validateArrowReferences(node.test)
        this.validateArrowReferences(node.consequent)
        this.validateArrowReferences(node.alternate)
        return
      case 'member':
        this.validateArrowReferences(node.object)
        if (node.computed) this.validateArrowReferences(node.property)
        return
      case 'call':
        this.validateArrowReferences(node.callee)
        for (const arg of node.args) this.validateArrowReferences(arg)
        return
      case 'array':
        for (const element of node.elements) {
          if (element) this.validateArrowReferences(element)
        }
        return
      case 'object':
        for (const prop of node.props) {
          if (prop.type === 'spread') {
            this.validateArrowReferences(prop.argument)
          } else {
            if (prop.computed) this.validateArrowReferences(prop.key)
            this.validateArrowReferences(prop.value)
          }
        }
        return
      case 'spread':
        this.validateArrowReferences(node.argument)
        return
      case 'template':
        if (node.tag) this.validateArrowReferences(node.tag)
        for (const expression of node.expressions) this.validateArrowReferences(expression)
        return
      case 'sequence':
        for (const expression of node.expressions) this.validateArrowReferences(expression)
        return
      case 'pipeline':
        this.validateArrowReferences(node.left)
        this.validateArrowReferences(node.right)
        return
    }
  }

  private findMatchingParenIndex(startIndex: number): number {
    let depth = 0

    for (let index = startIndex; index < this.tokens.length; index += 1) {
      const token = this.tokens[index]
      if (token.kind !== 'op') continue
      if (token.raw === '(') depth += 1
      else if (token.raw === ')') {
        depth -= 1
        if (depth === 0) return index
      }
    }

    return -1
  }

  private hasLineTerminatorBetween(start: number | undefined, end: number | undefined): boolean {
    if (start === undefined || end === undefined || !this.src) return false
    return /[\n\r\u2028\u2029]/.test(this.src.slice(start, end))
  }

  private peek(): JSToken | undefined {
    return this.tokens[this.pos]
  }
  private advance(): JSToken | undefined {
    return this.tokens[this.pos++]
  }
  private lastEnd(): number {
    return this.tokens[this.pos - 1]?.end ?? 0
  }

  private assertValidLogicalMixing(
    operator: '&&' | '||' | '??',
    left: JSExprNode,
    right: JSExprNode,
    token: JSToken,
  ): void {
    const mixesNullishWithBoolean =
      operator === '??'
        ? this.isUnparenthesizedShortCircuit(left) || this.isUnparenthesizedShortCircuit(right)
        : this.isUnparenthesizedNullish(left) || this.isUnparenthesizedNullish(right)

    if (mixesNullishWithBoolean) {
      throw new JSParseError(
        "Cannot mix '??' with '&&' or '||' without parentheses",
        token,
        this.src,
      )
    }
  }

  private isUnparenthesizedNullish(node: JSExprNode): boolean {
    return !this.parenthesizedNodes.has(node) && node.type === 'logical' && node.operator === '??'
  }

  private isUnparenthesizedShortCircuit(node: JSExprNode): boolean {
    return (
      !this.parenthesizedNodes.has(node) &&
      node.type === 'logical' &&
      (node.operator === '&&' || node.operator === '||')
    )
  }

  private validateTopicUsage(node: JSExprNode): void {
    this.validateExpressionTopicUsage(node, false)
  }

  private validateExpressionTopicUsage(node: JSExprNode, allowTopic: boolean): number {
    switch (node.type) {
      case 'literal':
      case 'regex':
      case 'identifier':
        return 0

      case 'topic':
        if (!allowTopic) {
          throw new JSParseError(
            "Topic reference '%' is only allowed inside a pipeline body",
            undefined,
            this.src,
          )
        }
        return 1

      case 'arrow-function': {
        let topicCount = 0
        for (const param of node.params) {
          topicCount += this.validateBindingTopicUsage(param.binding, allowTopic)
        }
        topicCount += this.validateExpressionTopicUsage(node.body, allowTopic)
        return topicCount
      }

      case 'unary':
        return this.validateExpressionTopicUsage(node.operand, allowTopic)

      case 'binary':
      case 'logical':
        return (
          this.validateExpressionTopicUsage(node.left, allowTopic) +
          this.validateExpressionTopicUsage(node.right, allowTopic)
        )

      case 'conditional':
        return (
          this.validateExpressionTopicUsage(node.test, allowTopic) +
          this.validateExpressionTopicUsage(node.consequent, allowTopic) +
          this.validateExpressionTopicUsage(node.alternate, allowTopic)
        )

      case 'member':
        return (
          this.validateExpressionTopicUsage(node.object, allowTopic) +
          this.validateExpressionTopicUsage(node.property, allowTopic)
        )

      case 'call': {
        let topicCount = this.validateExpressionTopicUsage(node.callee, allowTopic)
        for (const arg of node.args)
          topicCount += this.validateExpressionTopicUsage(arg, allowTopic)
        return topicCount
      }

      case 'array': {
        let topicCount = 0
        for (const element of node.elements) {
          if (element !== null) topicCount += this.validateExpressionTopicUsage(element, allowTopic)
        }
        return topicCount
      }

      case 'object': {
        let topicCount = 0
        for (const prop of node.props) {
          topicCount +=
            prop.type === 'spread'
              ? this.validateExpressionTopicUsage(prop.argument, allowTopic)
              : (prop.computed ? this.validateExpressionTopicUsage(prop.key, allowTopic) : 0) +
              this.validateExpressionTopicUsage(prop.value, allowTopic)
        }
        return topicCount
      }

      case 'spread':
        return this.validateExpressionTopicUsage(node.argument, allowTopic)

      case 'template': {
        let topicCount = node.tag ? this.validateExpressionTopicUsage(node.tag, allowTopic) : 0
        for (const expression of node.expressions) {
          topicCount += this.validateExpressionTopicUsage(expression, allowTopic)
        }
        return topicCount
      }

      case 'sequence': {
        let topicCount = 0
        for (const expression of node.expressions) {
          topicCount += this.validateExpressionTopicUsage(expression, allowTopic)
        }
        return topicCount
      }

      case 'pipeline': {
        const outerTopicCount = this.validateExpressionTopicUsage(node.left, allowTopic)
        this.validatePipeBodyTopicUsage(node.right)
        return outerTopicCount
      }
    }
  }

  private validateBindingTopicUsage(binding: JSBindingNode, allowTopic: boolean): number {
    switch (binding.type) {
      case 'binding-identifier':
        return 0
      case 'binding-assignment':
        return (
          this.validateBindingTopicUsage(binding.left, allowTopic) +
          this.validateExpressionTopicUsage(binding.defaultValue, allowTopic)
        )
      case 'binding-array': {
        let topicCount = 0
        for (const element of binding.elements) {
          if (element) topicCount += this.validateBindingTopicUsage(element, allowTopic)
        }
        if (binding.rest) topicCount += this.validateBindingTopicUsage(binding.rest, allowTopic)
        return topicCount
      }
      case 'binding-object': {
        let topicCount = 0
        for (const prop of binding.properties) {
          if (prop.computed) topicCount += this.validateExpressionTopicUsage(prop.key, allowTopic)
          topicCount += this.validateBindingTopicUsage(prop.value, allowTopic)
        }
        return topicCount
      }
    }
  }

  private validatePipeBodyTopicUsage(node: JSExprNode): void {
    if (
      (node.type === 'conditional' || node.type === 'arrow-function') &&
      !this.parenthesizedNodes.has(node)
    ) {
      throw new JSParseError(
        `Hack pipe body cannot be an unparenthesized ${node.type === 'conditional' ? 'conditional expression' : 'arrow function'}`,
        undefined,
        this.src,
      )
    }

    if (this.validateExpressionTopicUsage(node, true) === 0) {
      throw new JSParseError("Hack pipe body must reference '%' at least once", undefined, this.src)
    }
  }

  private expect(kind: JSTokenKind, msg?: string): JSToken {
    const t = this.advance()
    if (!t || t.kind !== kind)
      throw new JSParseError(
        msg ?? `Expected ${kind}, got '${t?.raw ?? 'end of input'}'`,
        t,
        this.src,
      )
    return t
  }

  private expectOp(raw: string, msg?: string): JSToken {
    const t = this.advance()
    if (!t || t.raw !== raw)
      throw new JSParseError(
        msg ?? `Expected '${raw}', got '${t?.raw ?? 'end of input'}'`,
        t ?? this.tokens[this.pos - 1],
        this.src,
      )
    return t
  }
}

// #endregion
