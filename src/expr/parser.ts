import type { JSToken, JSTokenKind } from './lexer.js'
import type {
  ArrowFunctionExpression,
  BinaryExpression,
  CallExpression,
  ChainExpression,
  ConditionalExpression,
  ExpressionNode,
  LogicalExpression,
  MemberExpression,
  PipelineExpression,
  Property,
  SequenceExpression,
  SpreadElement,
  TaggedTemplateExpression,
  TemplateLiteral,
  TopicReference,
  UnaryExpression,
} from './node-types.js'
import {
  isArrowFunctionStart as detectArrowFunctionStart,
  type ParserBindingDelegate,
  parseArrowFunction as parseArrowFunctionWithBindings,
} from './parser/bindings.js'
import { JSParseError, type JSParserOptions } from './parser/errors.js'
import {
  FORBIDDEN_ASSIGNMENT_OPERATORS,
  FORBIDDEN_PREFIX_IDENTIFIERS,
  INFIX_PREC,
  PREC,
  RIGHT_ASSOC,
} from './parser/grammar.js'
import { parseStringValue } from './parser/shared.js'
import { buildTemplateAstNode } from './parser/template.js'
import { assertValidLogicalMixing, validateTopicUsage } from './parser/validation.js'

export type { JSParserOptions } from './parser/errors.js'
export { JSParseError } from './parser/errors.js'

// #region Public parser

/** Pratt-style parser that converts tokens into expression AST nodes. */
export class JSExpressionParser {
  private pos = 0
  private readonly parenthesizedNodes = new WeakSet<ExpressionNode>()
  private readonly src: string

  constructor(
    private readonly tokens: JSToken[],
    private readonly opts: JSParserOptions = {},
    src = '',
  ) {
    this.src = src
  }

  // #region Entry points

  parse(): ExpressionNode {
    if (this.tokens.length === 0) throw new JSParseError('Empty expression')
    const node = this.parseSequenceExpr()
    if (this.pos < this.tokens.length) {
      const t = this.peek()!
      throw new JSParseError(`Unexpected token '${t.raw}' after expression`, t, this.src)
    }
    validateTopicUsage(node, this.parenthesizedNodes, this.src)
    return node
  }

  // #endregion

  // #region Expression parsing

  private parseSequenceExpr(): ExpressionNode {
    let left = this.parseAssignmentExpr()

    while (this.peek()?.kind === 'op' && this.peek()!.raw === ',') {
      this.advance()
      const right = this.parseAssignmentExpr()
      left = {
        type: 'SequenceExpression',
        expressions:
          left.type === 'SequenceExpression' ? [...left.expressions, right] : [left, right],
        start: left.start,
        end: this.lastEnd(),
      } satisfies SequenceExpression
    }

    return left
  }

  private parseAssignmentExpr(): ExpressionNode {
    if (this.isArrowFunctionStart()) return this.parseArrowFunction()
    return this.parsePipeExpr()
  }

  private parsePipeExpr(): ExpressionNode {
    let left = this.parseConditionalExpr()

    while (this.peek()?.kind === 'op' && this.peek()!.raw === '|>') {
      const pipe = this.advance()!
      const right = this.parseAssignmentExpr()
      left = {
        type: 'PipelineExpression',
        left,
        right,
        start: left.start ?? pipe.start,
        end: this.lastEnd(),
      } satisfies PipelineExpression
    }

    return left
  }

  private parseConditionalExpr(): ExpressionNode {
    const test = this.parseShortCircuitExpr()
    if (this.peek()?.kind !== 'op' || this.peek()!.raw !== '?') return test

    this.advance()
    const consequent = this.parseAssignmentExpr()
    this.expectOp(':', 'Expected `:` in ternary expression')
    const alternate = this.parseAssignmentExpr()

    return {
      type: 'ConditionalExpression',
      test,
      consequent,
      alternate,
      start: test.start,
      end: this.lastEnd(),
    } satisfies ConditionalExpression
  }

  private parseShortCircuitExpr(): ExpressionNode {
    return this.parseExpr(PREC.NULLCOAL)
  }

  // parseExpr(minPrec) — standard Pratt loop
  private parseExpr(minPrec: number): ExpressionNode {
    let left = this.parsePrimary()

    for (;;) {
      const t = this.peek()
      if (!t) break

      // ── Postfix: member access, call, optional chaining ──────────
      if (t.kind === 'op' && t.raw === '.' && PREC.POSTFIX >= minPrec) {
        this.advance()
        const prop = this.expect('identifier', 'Expected property name after .')
        left = this.appendMember(
          left,
          { type: 'Identifier', name: prop.raw, start: prop.start, end: prop.end },
          false,
          false,
          prop.end,
        )
        continue
      }

      if (t.kind === 'op' && t.raw === '?.' && PREC.POSTFIX >= minPrec) {
        this.advance()
        const next = this.peek()
        if (next?.kind === 'op' && next.raw === '(') {
          this.advance()
          const args = this.parseArgList()
          left = this.appendCall(left, args, true, this.lastEnd())
        } else if (next?.kind === 'op' && next.raw === '[') {
          this.advance()
          const prop = this.parseSequenceExpr()
          this.expectOp(']')
          left = this.appendMember(left, prop, true, true, this.lastEnd())
        } else {
          const prop = this.expect('identifier', 'Expected identifier after ?.')
          left = this.appendMember(
            left,
            { type: 'Identifier', name: prop.raw, start: prop.start, end: prop.end },
            false,
            true,
            prop.end,
          )
        }
        continue
      }

      if (t.kind === 'op' && t.raw === '[' && PREC.POSTFIX >= minPrec) {
        this.advance()
        const prop = this.parseSequenceExpr()
        this.expectOp(']')
        left = this.appendMember(left, prop, true, false, this.lastEnd())
        continue
      }

      if (t.kind === 'op' && t.raw === '(' && PREC.POSTFIX >= minPrec) {
        this.advance()
        const args = this.parseArgList()
        left = this.appendCall(left, args, false, this.lastEnd())
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
        if (left.type === 'ChainExpression' && !this.parenthesizedNodes.has(left)) {
          throw new JSParseError(
            'Tagged templates are not allowed in an optional chain',
            t,
            this.src,
          )
        }
        this.advance()
        const quasi = this.buildTemplateNode(t, true)
        left = {
          type: 'TaggedTemplateExpression',
          tag: left,
          quasi,
          start: left.start,
          end: quasi.end,
        } satisfies TaggedTemplateExpression
        continue
      }

      // ── `in` keyword as infix operator (if enabled) ───────────────
      if (t.kind === 'identifier' && t.raw === 'in' && this.opts.allowIn !== false) {
        const prec = PREC.RELATIONAL
        if (prec < minPrec) break
        this.advance()
        const right = this.parseExpr(prec + 1)
        left = {
          type: 'BinaryExpression',
          operator: 'in',
          left,
          right,
          start: left.start,
          end: this.lastEnd(),
        } satisfies BinaryExpression
        continue
      }

      // ── `instanceof` keyword as infix operator ────────────────────
      if (t.kind === 'identifier' && t.raw === 'instanceof') {
        const prec = PREC.RELATIONAL
        if (prec < minPrec) break
        this.advance()
        const right = this.parseExpr(prec + 1)
        left = {
          type: 'BinaryExpression',
          operator: 'instanceof',
          left,
          right,
          start: left.start,
          end: this.lastEnd(),
        } satisfies BinaryExpression
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
          assertValidLogicalMixing(t.raw, left, right, t, this.parenthesizedNodes, this.src)
          left = {
            type: 'LogicalExpression',
            operator: t.raw as any,
            left,
            right,
            start: left.start,
            end: this.lastEnd(),
          } satisfies LogicalExpression
        } else {
          left = {
            type: 'BinaryExpression',
            operator: t.raw as BinaryExpression['operator'],
            left,
            right,
            start: left.start,
            end: this.lastEnd(),
          } satisfies BinaryExpression
        }
        continue
      }

      break
    }

    return left
  }

  private unwrapOpenChain(left: ExpressionNode): {
    expression: ExpressionNode
    chained: boolean
  } {
    if (left.type === 'ChainExpression' && !this.parenthesizedNodes.has(left)) {
      return { expression: left.expression, chained: true }
    }
    return { expression: left, chained: false }
  }

  private appendMember(
    left: ExpressionNode,
    property: ExpressionNode,
    computed: boolean,
    optional: boolean,
    end: number,
  ): ExpressionNode {
    const { expression: object, chained } = this.unwrapOpenChain(left)
    const member = {
      type: 'MemberExpression',
      object,
      property,
      computed,
      optional,
      start: left.start,
      end,
    } satisfies MemberExpression

    return optional || chained
      ? ({
          type: 'ChainExpression',
          expression: member,
          start: left.start,
          end,
        } satisfies ChainExpression)
      : member
  }

  private appendCall(
    left: ExpressionNode,
    args: Array<ExpressionNode | SpreadElement>,
    optional: boolean,
    end: number,
  ): ExpressionNode {
    const { expression: callee, chained } = this.unwrapOpenChain(left)
    const call = {
      type: 'CallExpression',
      callee,
      arguments: args,
      optional,
      start: left.start,
      end,
    } satisfies CallExpression

    return optional || chained
      ? ({
          type: 'ChainExpression',
          expression: call,
          start: left.start,
          end,
        } satisfies ChainExpression)
      : call
  }

  // #endregion

  // #region Primary parsing

  // parsePrimary — null-denotation (prefix position)
  private parsePrimary(): ExpressionNode {
    const t = this.peek()
    if (!t) throw new JSParseError('Unexpected end of expression')

    // ── Literals ────────────────────────────────────────────────────
    if (t.kind === 'number') {
      this.advance()
      const raw = t.raw.replace(/_/g, '') // numeric separators
      return { type: 'Literal', value: Number(raw), raw: t.raw, start: t.start, end: t.end }
    }
    if (t.kind === 'bigint') {
      this.advance()
      const raw = t.raw.replace(/_/g, '').slice(0, -1) // remove 'n'
      return {
        type: 'Literal',
        value: BigInt(
          raw.startsWith('0x') || raw.startsWith('0o') || raw.startsWith('0b') ? raw : raw,
        ),
        bigint: BigInt(raw).toString(),
        raw: t.raw,
        start: t.start,
        end: t.end,
      }
    }
    if (t.kind === 'string') {
      this.advance()
      return {
        type: 'Literal',
        value: parseStringValue(t.raw),
        raw: t.raw,
        start: t.start,
        end: t.end,
      }
    }
    if (t.kind === 'boolean') {
      this.advance()
      return { type: 'Literal', value: t.raw === 'true', raw: t.raw, start: t.start, end: t.end }
    }
    if (t.kind === 'null') {
      this.advance()
      return { type: 'Literal', value: null, raw: t.raw, start: t.start, end: t.end }
    }
    if (t.kind === 'undefined') {
      this.advance()
      return { type: 'Identifier', name: 'undefined', start: t.start, end: t.end }
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
        type: 'Literal',
        value: null,
        regex: {
          pattern: t.raw.slice(1, lastSlash),
          flags: t.raw.slice(lastSlash + 1),
        },
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
      return this.buildTemplateNode(t, false)
    }

    // ── Identifier ──────────────────────────────────────────────────
    if (t.kind === 'identifier') {
      // Forbidden constructs in prefix position
      if (FORBIDDEN_PREFIX_IDENTIFIERS.has(t.raw))
        throw new JSParseError(`'${t.raw}' is not allowed in read-only expressions`, t, this.src)

      // Unary keyword operators
      if (t.raw === 'typeof' || t.raw === 'void') {
        this.advance()
        const argument = this.parseExpr(PREC.UNARY)
        return {
          type: 'UnaryExpression',
          operator: t.raw,
          prefix: true,
          argument,
          start: t.start,
          end: this.lastEnd(),
        } satisfies UnaryExpression
      }
      if (t.raw === 'await') {
        if (!this.opts.allowAwait)
          throw new JSParseError(
            "'await' is not enabled in this context (pass { allowAwait: true })",
            t,
            this.src,
          )
        this.advance()
        const argument = this.parseExpr(PREC.UNARY)
        return { type: 'AwaitExpression', argument, start: t.start, end: this.lastEnd() }
      }

      this.advance()
      return { type: 'Identifier', name: t.raw, start: t.start, end: t.end }
    }

    // ── Unary prefix operators ───────────────────────────────────────
    if (t.kind === 'op') {
      if (t.raw === '%') {
        this.advance()
        return { type: 'TopicReference', start: t.start, end: t.end } satisfies TopicReference
      }

      if (t.raw === '!' || t.raw === '~' || t.raw === '+' || t.raw === '-') {
        this.advance()
        const argument = this.parseExpr(PREC.EXP)
        return {
          type: 'UnaryExpression',
          operator: t.raw,
          prefix: true,
          argument,
          start: t.start,
          end: this.lastEnd(),
        } satisfies UnaryExpression
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
        const elements: Array<ExpressionNode | SpreadElement | null> = []
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
              type: 'SpreadElement',
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
        return { type: 'ArrayExpression', elements, start: t.start, end: this.lastEnd() }
      }

      // Object literal
      if (t.raw === '{') {
        this.advance()
        const properties: Array<Property | SpreadElement> = []
        while (this.peek()?.raw !== '}') {
          if (!this.peek()) throw new JSParseError('Unterminated object literal', t, this.src)

          // Spread property
          if (this.peek()!.raw === '...') {
            const spread = this.advance()!
            properties.push({
              type: 'SpreadElement',
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
            properties.push({
              type: 'Property',
              key,
              value,
              kind: 'init',
              method: false,
              computed: true,
              shorthand: false,
              start: lb.start,
              end: this.lastEnd(),
            })
          } else {
            // Regular or shorthand key
            const keyTok = this.advance()!
            if (!keyTok) throw new JSParseError('Expected property key', undefined, this.src)
            const key = propertyKeyFromToken(keyTok)

            if (this.peek()?.raw === ':') {
              this.advance()
              const value = this.parseAssignmentExpr()
              properties.push({
                type: 'Property',
                key,
                value,
                kind: 'init',
                method: false,
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
              properties.push({
                type: 'Property',
                key,
                value: {
                  type: 'Identifier',
                  name: keyTok.raw,
                  start: keyTok.start,
                  end: keyTok.end,
                },
                kind: 'init',
                method: false,
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
        return { type: 'ObjectExpression', properties, start: t.start, end: this.lastEnd() }
      }
    }

    throw new JSParseError(`Unexpected token '${t.raw}'`, t, this.src)
  }

  private parseArgList(): Array<ExpressionNode | SpreadElement> {
    const args: Array<ExpressionNode | SpreadElement> = []
    while (this.peek()?.raw !== ')') {
      if (!this.peek()) throw new JSParseError('Unterminated argument list')
      if (this.peek()!.raw === '...') {
        const s = this.advance()!
        args.push({
          type: 'SpreadElement',
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

  // #endregion

  // #region Arrow parsing

  private createBindingDelegate(): ParserBindingDelegate {
    return {
      opts: this.opts,
      src: this.src,
      tokens: this.tokens,
      position: this.pos,
      peek: () => this.peek(),
      advance: () => this.advance(),
      lastEnd: () => this.lastEnd(),
      expect: (kind, msg) => this.expect(kind, msg),
      expectOp: (raw, msg) => this.expectOp(raw, msg),
      parseAssignmentExpr: () => this.parseAssignmentExpr(),
      parseSequenceExpr: () => this.parseSequenceExpr(),
      hasLineTerminatorBetween: (start, end) => this.hasLineTerminatorBetween(start, end),
    }
  }

  private isArrowFunctionStart(): boolean {
    return detectArrowFunctionStart(this.createBindingDelegate())
  }

  private parseArrowFunction(): ArrowFunctionExpression {
    return parseArrowFunctionWithBindings(this.createBindingDelegate())
  }

  // #endregion

  // #region Parser helpers

  private buildTemplateNode(tok: JSToken, tagged: boolean): TemplateLiteral {
    return buildTemplateAstNode(tok, tagged, this.src, (exprTokens) => {
      const parser = new JSExpressionParser(exprTokens, this.opts, this.src)
      return parser.parse()
    })
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

  // #endregion
}

function propertyKeyFromToken(token: JSToken): ExpressionNode {
  const offsets = { start: token.start, end: token.end }
  if (token.kind === 'string') {
    return { type: 'Literal', value: parseStringValue(token.raw), raw: token.raw, ...offsets }
  }
  if (token.kind === 'number') {
    return {
      type: 'Literal',
      value: Number(token.raw.replace(/_/g, '')),
      raw: token.raw,
      ...offsets,
    }
  }
  if (token.kind === 'bigint') {
    const rawValue = token.raw.replace(/_/g, '').slice(0, -1)
    const value = BigInt(rawValue)
    return { type: 'Literal', value, bigint: value.toString(), raw: token.raw, ...offsets }
  }
  if (token.kind === 'boolean') {
    return { type: 'Literal', value: token.raw === 'true', raw: token.raw, ...offsets }
  }
  if (token.kind === 'null') {
    return { type: 'Literal', value: null, raw: token.raw, ...offsets }
  }
  return { type: 'Identifier', name: token.raw, ...offsets }
}

// #endregion
