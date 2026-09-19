import type { JSToken, JSTokenKind } from '../lexer/index.js'
import type {
  BindingPattern as PublicBindingPattern,
  ExpressionNode as PublicExpressionNode,
} from '../node-types.js'
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
} from '../operators.js'
import {
  isArrowFunctionStart as detectArrowFunctionStart,
  type ParserBindingDelegate,
  parseArrowFunction as parseArrowFunctionWithBindings,
  parseBindingPattern as parseBindingPatternWithDelegate,
} from './bindings.js'
import {
  type CollectionParserDelegate,
  parseArrayLiteral,
  parseObjectLiteral,
} from './collections.js'
import { JSIncompleteParseError, JSParseError, type JSParserOptions } from './errors.js'
import { finalizeAst } from './finalize.js'
import { FORBIDDEN_PREFIX_IDENTIFIERS } from './grammar.js'
import type {
  ArrowFunctionExpression,
  BinaryExpression,
  CallExpression,
  ChainExpression,
  ConditionalExpression,
  ExpressionNode,
  AssignmentPattern as InternalAssignmentPattern,
  BindingPattern as InternalBindingPattern,
  LogicalExpression,
  MemberExpression,
  PipelineExpression,
  SequenceExpression,
  SpreadElement,
  TaggedTemplateExpression,
  TemplateLiteral,
  TopicReference,
  UnaryExpression,
  UpdateExpression,
} from './node-types.js'
import { parseStringValue } from './shared.js'
import { buildTemplateAstNode } from './template.js'
import {
  assertValidLogicalMixing,
  validateBindingTopicUsage,
  validateTopicUsage,
} from './validation.js'

export interface JSExpressionPrefixResult {
  expression: PublicExpressionNode
  end: number
  nextToken?: JSToken
  rolledBack: boolean
}

export interface JSBindingPrefixResult {
  pattern: PublicBindingPattern
  end: number
  nextToken?: JSToken
  rolledBack: boolean
}

// #region Public parser

/** Pratt-style parser that converts tokens into expression AST nodes. */
export class JSExpressionParser {
  private pos = 0
  private rolledBack = false
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
    return finalizeAst(this.parseInternal(true, false), this.src, this.opts.locations)
  }

  parsePrefix(incomplete: 'error' | 'rollback' = 'error'): JSExpressionPrefixResult {
    this.rolledBack = false
    const node = this.parseInternal(false, incomplete === 'rollback')
    return {
      expression: finalizeAst(node, this.src, this.opts.locations),
      end: this.lastEnd(),
      nextToken: this.peek(),
      rolledBack: this.rolledBack,
    }
  }

  parseBindingPattern(): PublicBindingPattern {
    const node = this.parseBindingInternal(true, false)
    return finalizeAst(node, this.src, this.opts.locations)
  }

  parseBindingPrefix(incomplete: 'error' | 'rollback' = 'error'): JSBindingPrefixResult {
    this.rolledBack = false
    const node = this.parseBindingInternal(false, incomplete === 'rollback')
    return {
      pattern: finalizeAst(node, this.src, this.opts.locations),
      end: this.lastEnd(),
      nextToken: this.peek(),
      rolledBack: this.rolledBack,
    }
  }

  private parseInternal(requireComplete: boolean, rollbackOnIncomplete: boolean): ExpressionNode {
    if (this.tokens.length === 0) throw new JSParseError('Empty expression')
    const node = this.parseSequenceExpr(rollbackOnIncomplete)
    if (requireComplete && this.pos < this.tokens.length) {
      const t = this.peek()!
      throw new JSParseError(`Unexpected token '${t.value}' after expression`, t, this.src)
    }
    validateTopicUsage(node, this.parenthesizedNodes, this.src)
    return node
  }

  private parseBindingInternal(
    requireComplete: boolean,
    rollbackOnIncomplete: boolean,
  ): InternalBindingPattern {
    if (this.tokens.length === 0) throw new JSParseError('Empty binding pattern')
    let node = parseBindingPatternWithDelegate(this.createBindingDelegate())
    if (this.peek()?.kind === 'op' && this.peek()!.value === '=') {
      const continuationStart = this.pos
      this.advance()
      try {
        node = {
          type: 'AssignmentPattern',
          left: node,
          right: this.parseAssignmentExpr(),
          start: node.start,
          end: this.lastEnd(),
        } satisfies InternalAssignmentPattern
      } catch (error) {
        if (rollbackOnIncomplete && error instanceof JSIncompleteParseError) {
          this.rollbackTo(continuationStart)
        } else {
          throw error
        }
      }
    }
    if (requireComplete && this.pos < this.tokens.length) {
      const token = this.peek()!
      throw new JSParseError(
        `Unexpected token '${token.value}' after binding pattern`,
        token,
        this.src,
      )
    }
    validateBindingTopicUsage(node, this.parenthesizedNodes, this.src)
    return node
  }

  // #endregion

  // #region Expression parsing

  private parseSequenceExpr(rollbackOnIncomplete = false): ExpressionNode {
    let left = this.parseAssignmentExpr(rollbackOnIncomplete)

    while (this.peek()?.kind === 'op' && this.peek()!.value === ',') {
      const continuationStart = this.pos
      this.advance()
      let right: ExpressionNode
      try {
        right = this.parseAssignmentExpr()
      } catch (error) {
        if (rollbackOnIncomplete && error instanceof JSIncompleteParseError) {
          this.rollbackTo(continuationStart)
          break
        }
        throw error
      }
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

  private parseAssignmentExpr(rollbackOnIncomplete = false): ExpressionNode {
    if (this.isArrowFunctionStart()) {
      if (!rollbackOnIncomplete) return this.parseArrowFunction()
      const continuationStart = this.pos
      try {
        return this.parseArrowFunction()
      } catch (error) {
        if (!(error instanceof JSIncompleteParseError)) throw error
        this.rollbackTo(continuationStart)
        return this.parsePipeExpr()
      }
    }
    if (!this.opts.allowAssignments) return this.parsePipeExpr(rollbackOnIncomplete)
    const left = this.parsePipeExpr(rollbackOnIncomplete)
    const assignment = this.peek()
    if (assignment?.kind !== 'op' || !isAssignmentOperator(assignment.value)) {
      return left
    }
    this.assertWritableTarget(left, assignment, 'assigned')
    const continuationStart = this.pos
    this.advance()
    try {
      return {
        type: 'AssignmentExpression',
        operator: assignment.value,
        left,
        right: this.parseAssignmentExpr(),
        start: left.start,
        end: this.lastEnd(),
      }
    } catch (error) {
      if (rollbackOnIncomplete && error instanceof JSIncompleteParseError) {
        this.rollbackTo(continuationStart)
        return left
      }
      throw error
    }
  }

  private parsePipeExpr(rollbackOnIncomplete = false): ExpressionNode {
    let left = this.parseConditionalExpr(rollbackOnIncomplete)

    while (this.peek()?.kind === 'op' && this.peek()!.value === '|>') {
      const continuationStart = this.pos
      const pipe = this.advance()!
      let right: ExpressionNode
      try {
        right = this.parseAssignmentExpr()
      } catch (error) {
        if (rollbackOnIncomplete && error instanceof JSIncompleteParseError) {
          this.rollbackTo(continuationStart)
          break
        }
        throw error
      }
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

  private parseConditionalExpr(rollbackOnIncomplete = false): ExpressionNode {
    const test = this.parseShortCircuitExpr(rollbackOnIncomplete)
    if (this.peek()?.kind !== 'op' || this.peek()!.value !== '?') return test

    const continuationStart = this.pos
    this.advance()
    try {
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
    } catch (error) {
      if (rollbackOnIncomplete && error instanceof JSIncompleteParseError) {
        this.rollbackTo(continuationStart)
        return test
      }
      throw error
    }
  }

  private parseShortCircuitExpr(rollbackOnIncomplete = false): ExpressionNode {
    return this.parseExpr(PREC.NULLCOAL, rollbackOnIncomplete)
  }

  // parseExpr(minPrec) — standard Pratt loop
  private parseExpr(minPrec: number, rollbackOnIncomplete = false): ExpressionNode {
    let left = this.parsePrimary()

    for (;;) {
      const t = this.peek()
      if (!t) break
      const continuationStart = this.pos

      try {
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
      } catch (error) {
        if (rollbackOnIncomplete && error instanceof JSIncompleteParseError) {
          this.rollbackTo(continuationStart)
          break
        }
        throw error
      }
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
    if (!t) throw new JSIncompleteParseError('Unexpected end of expression')

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
        return parseArrayLiteral(this.createCollectionDelegate(), t)
      }

      // Object literal
      if (t.value === '{') {
        return parseObjectLiteral(this.createCollectionDelegate(), t)
      }
    }

    throw new JSParseError(`Unexpected token '${t.value}'`, t, this.src)
  }

  private parseArgList(): Array<ExpressionNode | SpreadElement> {
    const args: Array<ExpressionNode | SpreadElement> = []
    while (this.peek()?.value !== ')') {
      if (!this.peek()) throw new JSIncompleteParseError('Unterminated argument list')
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

  private createCollectionDelegate(): CollectionParserDelegate {
    return {
      src: this.src,
      peek: (offset = 0) => this.peek(offset),
      advance: () => this.advance(),
      lastEnd: () => this.lastEnd(),
      expectOp: (raw, message) => this.expectOp(raw, message),
      parseAssignmentExpr: () => this.parseAssignmentExpr(),
      parseSequenceExpr: () => this.parseSequenceExpr(),
    }
  }

  private createBindingDelegate(): ParserBindingDelegate {
    return {
      opts: this.opts,
      src: this.src,
      peek: (offset = 0) => this.peek(offset),
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
      return parser.parseInternal(true, false)
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

  private peek(offset = 0): JSToken | undefined {
    return this.tokens[this.pos + offset]
  }
  private advance(): JSToken | undefined {
    return this.tokens[this.pos++]
  }
  private lastEnd(): number {
    return this.tokens[this.pos - 1]?.end ?? 0
  }

  private rollbackTo(position: number): void {
    this.pos = position
    this.rolledBack = true
  }

  private expect(kind: JSTokenKind, msg?: string): JSToken {
    const t = this.advance()
    if (!t) {
      throw new JSIncompleteParseError(
        msg ?? `Expected ${kind}, got 'end of input'`,
        undefined,
        this.src,
      )
    }
    if (t.kind !== kind)
      throw new JSParseError(msg ?? `Expected ${kind}, got '${t.value}'`, t, this.src)
    return t
  }

  private expectOp(raw: string, msg?: string): JSToken {
    const t = this.advance()
    if (!t) {
      throw new JSIncompleteParseError(
        msg ?? `Expected '${raw}', got 'end of input'`,
        this.tokens[this.pos - 1],
        this.src,
      )
    }
    if (t.value !== raw)
      throw new JSParseError(msg ?? `Expected '${raw}', got '${t.value}'`, t, this.src)
    return t
  }

  // #endregion
}

// #endregion
