import type { JSToken, JSTokenKind } from './lexer/index.js'
import type { ExpressionNode as PublicExpressionNode } from './node-types.js'
import {
  BINARY_OPERATOR_INFO,
  getInfixOperatorInfo,
  isAssignmentOperator,
  isBinaryKeywordOperator,
  isBinaryOperator,
  isLogicalOperator,
  isUnaryKeywordOperator,
  isUnarySymbolOperator,
  isUpdateOperator,
  PREC,
} from './operators.js'
import {
  isArrowFunctionStart as detectArrowFunctionStart,
  type ParserBindingDelegate,
  parseArrowFunction as parseArrowFunctionWithBindings,
} from './parser/bindings.js'
import { type JSLocationOptions, JSParseError, type JSParserOptions } from './parser/errors.js'
import { FORBIDDEN_PREFIX_IDENTIFIERS } from './parser/grammar.js'
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
  UpdateExpression,
} from './parser/node-types.js'
import { parseStringValue } from './parser/shared.js'
import { buildTemplateAstNode } from './parser/template.js'
import { assertValidLogicalMixing, validateTopicUsage } from './parser/validation.js'

export type { JSLocationOptions, JSParserOptions } from './parser/errors.js'
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

  parse(): PublicExpressionNode {
    return finalizeAst(this.parseInternal(), this.src, this.opts.locations)
  }

  private parseInternal(): ExpressionNode {
    if (this.tokens.length === 0) throw new JSParseError('Empty expression')
    const node = this.parseSequenceExpr()
    if (this.pos < this.tokens.length) {
      const t = this.peek()!
      throw new JSParseError(`Unexpected token '${t.value}' after expression`, t, this.src)
    }
    validateTopicUsage(node, this.parenthesizedNodes, this.src)
    return node
  }

  // #endregion

  // #region Expression parsing

  private parseSequenceExpr(): ExpressionNode {
    let left = this.parseAssignmentExpr()

    while (this.peek()?.kind === 'op' && this.peek()!.value === ',') {
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
    if (!this.opts.allowAssignments) return this.parsePipeExpr()
    const left = this.parsePipeExpr()
    const assignment = this.peek()
    if (assignment?.kind !== 'op' || !isAssignmentOperator(assignment.value)) {
      return left
    }
    this.assertWritableTarget(left, assignment, 'assigned')
    this.advance()
    return {
      type: 'AssignmentExpression',
      operator: assignment.value,
      left,
      right: this.parseAssignmentExpr(),
      start: left.start,
      end: this.lastEnd(),
    }
  }

  private parsePipeExpr(): ExpressionNode {
    let left = this.parseConditionalExpr()

    while (this.peek()?.kind === 'op' && this.peek()!.value === '|>') {
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
    if (this.peek()?.kind !== 'op' || this.peek()!.value !== '?') return test

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
      if (t.kind === 'op' && t.value === '.' && PREC.POSTFIX >= minPrec) {
        this.advance()
        const prop = this.expect('identifier', 'Expected property name after .')
        left = this.appendMember(
          left,
          { type: 'Identifier', name: prop.value, start: prop.start, end: prop.end },
          false,
          false,
          prop.end,
        )
        continue
      }

      if (t.kind === 'op' && t.value === '?.' && PREC.POSTFIX >= minPrec) {
        this.advance()
        const next = this.peek()
        if (next?.kind === 'op' && next.value === '(') {
          this.advance()
          const args = this.parseArgList()
          left = this.appendCall(left, args, true, this.lastEnd())
        } else if (next?.kind === 'op' && next.value === '[') {
          this.advance()
          const prop = this.parseSequenceExpr()
          this.expectOp(']')
          left = this.appendMember(left, prop, true, true, this.lastEnd())
        } else {
          const prop = this.expect('identifier', 'Expected identifier after ?.')
          left = this.appendMember(
            left,
            { type: 'Identifier', name: prop.value, start: prop.start, end: prop.end },
            false,
            true,
            prop.end,
          )
        }
        continue
      }

      if (t.kind === 'op' && t.value === '[' && PREC.POSTFIX >= minPrec) {
        this.advance()
        const prop = this.parseSequenceExpr()
        this.expectOp(']')
        left = this.appendMember(left, prop, true, false, this.lastEnd())
        continue
      }

      if (t.kind === 'op' && t.value === '(' && PREC.POSTFIX >= minPrec) {
        this.advance()
        const args = this.parseArgList()
        left = this.appendCall(left, args, false, this.lastEnd())
        continue
      }

      // Update expressions bind after member/call access but before infix operators.
      if (t.kind === 'op' && isUpdateOperator(t.value) && PREC.POSTFIX >= minPrec) {
        if (!this.opts.allowAssignments) {
          throw new JSParseError(
            `Update operator '${t.value}' is not allowed in read-only expressions`,
            t,
            this.src,
          )
        }
        if (this.hasLineTerminatorBetween(left.end, t.start)) break
        this.assertWritableTarget(left, t, 'updated')
        this.advance()
        left = {
          type: 'UpdateExpression',
          operator: t.value,
          argument: left,
          prefix: false,
          start: left.start,
          end: t.end,
        } satisfies UpdateExpression
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

      // ── Keyword infix operators ────────────────────────────────────
      if (t.kind === 'identifier' && isBinaryKeywordOperator(t.value)) {
        if (t.value === 'in' && this.opts.allowIn === false) break
        const prec = BINARY_OPERATOR_INFO[t.value].precedence
        if (prec < minPrec) break
        this.advance()
        const right = this.parseExpr(prec + 1)
        left = {
          type: 'BinaryExpression',
          operator: t.value,
          left,
          right,
          start: left.start,
          end: this.lastEnd(),
        } satisfies BinaryExpression
        continue
      }

      // ── Regular infix operators ───────────────────────────────────
      if (t.kind === 'op') {
        if (isAssignmentOperator(t.value)) {
          if (!this.opts.allowAssignments) {
            throw new JSParseError(
              `Assignment operator '${t.value}' is not allowed in read-only expressions`,
              t,
              this.src,
            )
          }
          break
        }

        const info = getInfixOperatorInfo(t.value)
        if (!info || info.precedence < minPrec) break

        this.advance()
        const nextMin = info.associativity === 'right' ? info.precedence : info.precedence + 1
        const right = this.parseExpr(nextMin)

        // Logical operators get their own node type
        if (isLogicalOperator(t.value)) {
          assertValidLogicalMixing(t.value, left, right, t, this.parenthesizedNodes, this.src)
          left = {
            type: 'LogicalExpression',
            operator: t.value,
            left,
            right,
            start: left.start,
            end: this.lastEnd(),
          } satisfies LogicalExpression
        } else if (isBinaryOperator(t.value)) {
          left = {
            type: 'BinaryExpression',
            operator: t.value,
            left,
            right,
            start: left.start,
            end: this.lastEnd(),
          } satisfies BinaryExpression
        } else {
          break
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
      const raw = t.value.replace(/_/g, '') // numeric separators
      return { type: 'Literal', value: Number(raw), raw: t.value, start: t.start, end: t.end }
    }
    if (t.kind === 'bigint') {
      this.advance()
      const raw = t.value.replace(/_/g, '').slice(0, -1) // remove 'n'
      return {
        type: 'Literal',
        value: BigInt(
          raw.startsWith('0x') || raw.startsWith('0o') || raw.startsWith('0b') ? raw : raw,
        ),
        bigint: BigInt(raw).toString(),
        raw: t.value,
        start: t.start,
        end: t.end,
      }
    }
    if (t.kind === 'string') {
      this.advance()
      return {
        type: 'Literal',
        value: parseStringValue(t.value),
        raw: t.value,
        start: t.start,
        end: t.end,
      }
    }
    if (t.kind === 'boolean') {
      this.advance()
      return {
        type: 'Literal',
        value: t.value === 'true',
        raw: t.value,
        start: t.start,
        end: t.end,
      }
    }
    if (t.kind === 'null') {
      this.advance()
      return { type: 'Literal', value: null, raw: t.value, start: t.start, end: t.end }
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
      const lastSlash = t.value.lastIndexOf('/')
      return {
        type: 'Literal',
        value: null,
        regex: {
          pattern: t.value.slice(1, lastSlash),
          flags: t.value.slice(lastSlash + 1),
        },
        raw: t.value,
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
      if (FORBIDDEN_PREFIX_IDENTIFIERS.has(t.value))
        throw new JSParseError(`'${t.value}' is not allowed in read-only expressions`, t, this.src)

      // Unary keyword operators
      if (isUnaryKeywordOperator(t.value)) {
        this.advance()
        const argument = this.parseExpr(PREC.UNARY)
        return {
          type: 'UnaryExpression',
          operator: t.value,
          prefix: true,
          argument,
          start: t.start,
          end: this.lastEnd(),
        } satisfies UnaryExpression
      }
      if (t.value === 'await') {
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
      return { type: 'Identifier', name: t.value, start: t.start, end: t.end }
    }

    // ── Unary prefix operators ───────────────────────────────────────
    if (t.kind === 'op') {
      if (t.value === '%') {
        this.advance()
        return { type: 'TopicReference', start: t.start, end: t.end } satisfies TopicReference
      }

      if (isUnarySymbolOperator(t.value)) {
        this.advance()
        const argument = this.parseExpr(PREC.EXP)
        return {
          type: 'UnaryExpression',
          operator: t.value,
          prefix: true,
          argument,
          start: t.start,
          end: this.lastEnd(),
        } satisfies UnaryExpression
      }

      if (isUpdateOperator(t.value)) {
        if (!this.opts.allowAssignments) {
          throw new JSParseError(
            `Update operator '${t.value}' is not allowed in read-only expressions`,
            t,
            this.src,
          )
        }
        this.advance()
        const argument = this.parseExpr(PREC.UNARY)
        this.assertWritableTarget(argument, t, 'updated')
        return {
          type: 'UpdateExpression',
          operator: t.value,
          argument,
          prefix: true,
          start: t.start,
          end: this.lastEnd(),
        } satisfies UpdateExpression
      }

      // Grouping expression
      if (t.value === '(') {
        this.advance()
        if (this.peek()?.value === ')') {
          // empty parens only valid as arrow function params, not allowed
          throw new JSParseError('Empty parentheses are not a valid expression', t, this.src)
        }
        const expr = this.parseSequenceExpr()
        this.expectOp(')')
        this.parenthesizedNodes.add(expr)
        return expr
      }

      // Array literal
      if (t.value === '[') {
        this.advance()
        const elements: Array<ExpressionNode | SpreadElement | null> = []
        while (this.peek()?.value !== ']') {
          if (!this.peek()) throw new JSParseError('Unterminated array literal', t, this.src)
          if (this.peek()!.value === ',') {
            this.advance()
            elements.push(null) // hole
            continue
          }
          if (this.peek()!.value === '...') {
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
          if (this.peek()?.value === ',') this.advance()
          else break
        }
        this.expectOp(']', 'Unterminated array literal, expected ]')
        return { type: 'ArrayExpression', elements, start: t.start, end: this.lastEnd() }
      }

      // Object literal
      if (t.value === '{') {
        this.advance()
        const properties: Array<Property | SpreadElement> = []
        while (this.peek()?.value !== '}') {
          if (!this.peek()) throw new JSParseError('Unterminated object literal', t, this.src)

          // Spread property
          if (this.peek()!.value === '...') {
            const spread = this.advance()!
            properties.push({
              type: 'SpreadElement',
              argument: this.parseAssignmentExpr(),
              start: spread.start,
              end: this.lastEnd(),
            })
            if (this.peek()?.value === ',') this.advance()
            continue
          }

          // Computed key: [expr]: value
          if (this.peek()!.value === '[') {
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

            if (this.peek()?.value === ':') {
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
                  `Expected ':' after object key '${keyTok.value}'`,
                  keyTok,
                  this.src,
                )
              properties.push({
                type: 'Property',
                key,
                value: {
                  type: 'Identifier',
                  name: keyTok.value,
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
          if (this.peek()?.value === ',') this.advance()
          else break
        }
        this.expectOp('}', 'Unterminated object literal, expected }')
        return { type: 'ObjectExpression', properties, start: t.start, end: this.lastEnd() }
      }
    }

    throw new JSParseError(`Unexpected token '${t.value}'`, t, this.src)
  }

  private parseArgList(): Array<ExpressionNode | SpreadElement> {
    const args: Array<ExpressionNode | SpreadElement> = []
    while (this.peek()?.value !== ')') {
      if (!this.peek()) throw new JSParseError('Unterminated argument list')
      if (this.peek()!.value === '...') {
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
      if (this.peek()?.value === ',') this.advance()
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
      return parser.parseInternal()
    })
  }

  private hasLineTerminatorBetween(start: number | undefined, end: number | undefined): boolean {
    if (start === undefined || end === undefined || !this.src) return false
    return /[\n\r\u2028\u2029]/.test(this.src.slice(start, end))
  }

  private assertWritableTarget(
    node: ExpressionNode,
    token: JSToken,
    action: 'assigned' | 'updated',
  ): asserts node is Extract<ExpressionNode, { type: 'Identifier' | 'MemberExpression' }> {
    if (node.type === 'Identifier') return
    if (node.type === 'MemberExpression') {
      if (!this.opts.allowMemberWrites) {
        throw new JSParseError(
          'Member writes are not enabled in this context (pass { allowMemberWrites: true })',
          token,
          this.src,
        )
      }
      return
    }
    throw new JSParseError(
      `Only identifiers and member properties can be ${action}`,
      token,
      this.src,
    )
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
        msg ?? `Expected ${kind}, got '${t?.value ?? 'end of input'}'`,
        t,
        this.src,
      )
    return t
  }

  private expectOp(raw: string, msg?: string): JSToken {
    const t = this.advance()
    if (!t || t.value !== raw)
      throw new JSParseError(
        msg ?? `Expected '${raw}', got '${t?.value ?? 'end of input'}'`,
        t ?? this.tokens[this.pos - 1],
        this.src,
      )
    return t
  }

  // #endregion
}

function finalizeAst(
  ast: ExpressionNode,
  source: string,
  locations: JSParserOptions['locations'],
): PublicExpressionNode {
  const locationResolver = locations ? createLocationResolver(source, locations) : undefined

  const visit = (node: ExpressionNode): Record<string, unknown> => {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end') continue
      if (Array.isArray(value)) {
        result[key] = value.map((item) => (isInternalNode(item) ? visit(item) : item))
      } else {
        result[key] = isInternalNode(value) ? visit(value) : value
      }
    }
    if (locationResolver) result.loc = locationResolver(node.start, node.end)
    return result
  }

  return visit(ast) as unknown as PublicExpressionNode
}

function isInternalNode(value: unknown): value is ExpressionNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    typeof (value as { start?: unknown }).start === 'number' &&
    typeof (value as { end?: unknown }).end === 'number'
  )
}

function createLocationResolver(source: string, options: true | JSLocationOptions) {
  const startLine = options === true ? 1 : (options.startLine ?? 1)
  const startColumn = options === true ? 0 : (options.startColumn ?? 0)
  const sourceName = options === true ? undefined : options.source
  if (!Number.isInteger(startLine) || startLine < 1) {
    throw new TypeError('locations.startLine must be an integer greater than or equal to 1')
  }
  if (!Number.isInteger(startColumn) || startColumn < 0) {
    throw new TypeError('locations.startColumn must be a non-negative integer')
  }
  const lineStarts = [0]

  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index)
    if (code === 13 && source.charCodeAt(index + 1) === 10) index += 1
    if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) {
      lineStarts.push(index + 1)
    }
  }

  const positionAt = (offset: number) => {
    let low = 0
    let high = lineStarts.length
    while (low + 1 < high) {
      const middle = (low + high) >>> 1
      if (lineStarts[middle] <= offset) low = middle
      else high = middle
    }
    return {
      line: startLine + low,
      column: offset - lineStarts[low] + (low === 0 ? startColumn : 0),
    }
  }

  return (start: number, end: number) => ({
    ...(sourceName !== undefined ? { source: sourceName } : {}),
    start: positionAt(start),
    end: positionAt(end),
  })
}

function propertyKeyFromToken(token: JSToken): ExpressionNode {
  const offsets = { start: token.start, end: token.end }
  if (token.kind === 'string') {
    return { type: 'Literal', value: parseStringValue(token.value), raw: token.value, ...offsets }
  }
  if (token.kind === 'number') {
    return {
      type: 'Literal',
      value: Number(token.value.replace(/_/g, '')),
      raw: token.value,
      ...offsets,
    }
  }
  if (token.kind === 'bigint') {
    const rawValue = token.value.replace(/_/g, '').slice(0, -1)
    const value = BigInt(rawValue)
    return { type: 'Literal', value, bigint: value.toString(), raw: token.value, ...offsets }
  }
  if (token.kind === 'boolean') {
    return { type: 'Literal', value: token.value === 'true', raw: token.value, ...offsets }
  }
  if (token.kind === 'null') {
    return { type: 'Literal', value: null, raw: token.value, ...offsets }
  }
  return { type: 'Identifier', name: token.value, ...offsets }
}

// #endregion
