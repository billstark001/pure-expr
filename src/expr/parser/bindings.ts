import type { JSToken, JSTokenKind } from '../lexer/types.js'
import { JSParseError, type JSParserOptions } from './errors.js'
import { FORBIDDEN_ARROW_BINDING_IDENTIFIERS } from './grammar.js'
import type {
  ArrayPattern,
  ArrowFunctionExpression,
  AssignmentPattern,
  AssignmentProperty,
  BindingPattern,
  ExpressionNode,
  Identifier,
  ObjectPattern,
  RestElement,
} from './node-types.js'
import { parseStringValue } from './shared.js'
import { validateArrowFunction } from './validation.js'

export interface ParserBindingDelegate {
  readonly opts: JSParserOptions
  readonly src: string
  readonly tokens: readonly JSToken[]
  readonly position: number
  peek(): JSToken | undefined
  advance(): JSToken | undefined
  lastEnd(): number
  expect(kind: JSTokenKind, msg?: string): JSToken
  expectOp(raw: string, msg?: string): JSToken
  parseAssignmentExpr(): ExpressionNode
  parseSequenceExpr(): ExpressionNode
  hasLineTerminatorBetween(start: number | undefined, end: number | undefined): boolean
}

export function isArrowFunctionStart(delegate: ParserBindingDelegate): boolean {
  const start = delegate.peek()
  if (!start) return false

  if (start.kind === 'identifier') {
    const arrow = delegate.tokens[delegate.position + 1]
    return (
      arrow?.kind === 'op' &&
      arrow.value === '=>' &&
      !delegate.hasLineTerminatorBetween(start.end, arrow.start)
    )
  }

  if (start.kind === 'op' && start.value === '(') {
    const closeIndex = findMatchingParenIndex(delegate.tokens, delegate.position)
    if (closeIndex < 0) return false

    const close = delegate.tokens[closeIndex]
    const arrow = delegate.tokens[closeIndex + 1]
    return (
      close?.kind === 'op' &&
      close.value === ')' &&
      arrow?.kind === 'op' &&
      arrow.value === '=>' &&
      !delegate.hasLineTerminatorBetween(close.end, arrow.start)
    )
  }

  return false
}

export function parseArrowFunction(delegate: ParserBindingDelegate): ArrowFunctionExpression {
  if (delegate.opts.allowArrowFunctions === false) {
    throw new JSParseError(
      'Arrow functions are not enabled in this context',
      delegate.peek(),
      delegate.src,
    )
  }

  const start = delegate.peek()!
  let params: BindingPattern[]

  if (start.kind === 'identifier') {
    const param = bindingIdentifierFromToken(delegate, delegate.advance()!)
    delegate.expectOp('=>', 'Expected `=>` after arrow parameter')
    params = [param]
  } else {
    params = parseArrowParameterList(delegate)
    delegate.expectOp('=>', 'Expected `=>` after arrow parameters')
  }

  if (delegate.peek()?.kind === 'op' && delegate.peek()!.value === '{') {
    throw new JSParseError(
      'Arrow functions with block bodies are not supported in this context',
      delegate.peek(),
      delegate.src,
    )
  }

  const body = delegate.parseAssignmentExpr()
  const node = {
    type: 'ArrowFunctionExpression',
    params,
    body,
    expression: true,
    generator: false,
    async: false,
    start: start.start,
    end: delegate.lastEnd(),
  } satisfies ArrowFunctionExpression

  validateArrowFunction(node, delegate.src)
  return node
}

function parseArrowParameterList(delegate: ParserBindingDelegate): BindingPattern[] {
  const open = delegate.expectOp('(')
  const params: BindingPattern[] = []

  if (delegate.peek()?.kind === 'op' && delegate.peek()!.value === ')') {
    delegate.advance()
    return params
  }

  for (;;) {
    const start = delegate.peek()
    if (!start) throw new JSParseError('Unterminated arrow parameter list', open, delegate.src)

    if (start.kind === 'op' && start.value === '...') {
      delegate.advance()
      const argument = parseBindingPattern(delegate)
      params.push({
        type: 'RestElement',
        argument,
        start: start.start,
        end: delegate.lastEnd(),
      } satisfies RestElement)
      break
    }

    params.push(parseBindingElement(delegate))
    if (delegate.peek()?.kind !== 'op' || delegate.peek()!.value !== ',') break
    delegate.advance()
    if (delegate.peek()?.kind === 'op' && delegate.peek()!.value === ')') break
  }

  delegate.expectOp(')', 'Expected `)` after arrow parameters')
  return params
}

function parseBindingElement(delegate: ParserBindingDelegate): BindingPattern {
  const binding = parseBindingPattern(delegate)
  if (delegate.peek()?.kind === 'op' && delegate.peek()!.value === '=') {
    delegate.advance()
    return {
      type: 'AssignmentPattern',
      left: binding,
      right: delegate.parseAssignmentExpr(),
      start: binding.start,
      end: delegate.lastEnd(),
    } satisfies AssignmentPattern
  }
  return binding
}

function parseBindingPattern(delegate: ParserBindingDelegate): BindingPattern {
  const token = delegate.peek()
  if (!token) {
    throw new JSParseError('Unexpected end of arrow parameter list', undefined, delegate.src)
  }

  if (token.kind === 'identifier') {
    return bindingIdentifierFromToken(delegate, delegate.advance()!)
  }
  if (token.kind === 'op' && token.value === '[') return parseBindingArrayPattern(delegate)
  if (token.kind === 'op' && token.value === '{') return parseBindingObjectPattern(delegate)

  throw new JSParseError(
    `Unexpected token '${token.value}' in arrow parameter list`,
    token,
    delegate.src,
  )
}

function parseBindingArrayPattern(delegate: ParserBindingDelegate): ArrayPattern {
  const open = delegate.expectOp('[')
  const elements: Array<BindingPattern | null> = []

  while (delegate.peek()?.kind !== 'op' || delegate.peek()!.value !== ']') {
    if (!delegate.peek()) {
      throw new JSParseError('Unterminated array binding pattern', open, delegate.src)
    }
    if (delegate.peek()!.kind === 'op' && delegate.peek()!.value === ',') {
      delegate.advance()
      elements.push(null)
      continue
    }
    if (delegate.peek()!.kind === 'op' && delegate.peek()!.value === '...') {
      const spread = delegate.advance()!
      elements.push({
        type: 'RestElement',
        argument: parseBindingPattern(delegate),
        start: spread.start,
        end: delegate.lastEnd(),
      } satisfies RestElement)
      break
    }

    elements.push(parseBindingElement(delegate))
    if (delegate.peek()?.kind === 'op' && delegate.peek()!.value === ',') delegate.advance()
    else break
  }

  delegate.expectOp(']', 'Expected `]` after array binding pattern')
  return {
    type: 'ArrayPattern',
    elements,
    start: open.start,
    end: delegate.lastEnd(),
  }
}

function parseBindingObjectPattern(delegate: ParserBindingDelegate): ObjectPattern {
  const open = delegate.expectOp('{')
  const properties: Array<AssignmentProperty | RestElement> = []

  while (delegate.peek()?.kind !== 'op' || delegate.peek()!.value !== '}') {
    if (!delegate.peek()) {
      throw new JSParseError('Unterminated object binding pattern', open, delegate.src)
    }

    if (delegate.peek()!.kind === 'op' && delegate.peek()!.value === '...') {
      const spread = delegate.advance()!
      const argument = bindingIdentifierFromToken(
        delegate,
        delegate.expect('identifier', 'Expected identifier after object rest operator'),
      )
      properties.push({
        type: 'RestElement',
        argument,
        start: spread.start,
        end: delegate.lastEnd(),
      })
      break
    }

    if (delegate.peek()!.kind === 'op' && delegate.peek()!.value === '[') {
      const openBracket = delegate.advance()!
      const key = delegate.parseSequenceExpr()
      delegate.expectOp(']')
      delegate.expectOp(':', 'Expected `:` after computed binding key')
      properties.push({
        type: 'Property',
        key,
        value: parseBindingElement(delegate),
        kind: 'init',
        method: false,
        computed: true,
        shorthand: false,
        start: openBracket.start,
        end: delegate.lastEnd(),
      })
    } else {
      const keyTok = delegate.advance()!
      const key = tokenToPropertyKeyNode(keyTok)

      if (delegate.peek()?.kind === 'op' && delegate.peek()!.value === ':') {
        delegate.advance()
        properties.push({
          type: 'Property',
          key,
          value: parseBindingElement(delegate),
          kind: 'init',
          method: false,
          computed: false,
          shorthand: false,
          start: keyTok.start,
          end: delegate.lastEnd(),
        })
      } else {
        if (keyTok.kind !== 'identifier') {
          throw new JSParseError(
            `Expected ':' after binding key '${keyTok.value}'`,
            keyTok,
            delegate.src,
          )
        }

        const identifier = bindingIdentifierFromToken(delegate, keyTok)
        let value: BindingPattern = identifier
        if (delegate.peek()?.kind === 'op' && delegate.peek()!.value === '=') {
          delegate.advance()
          value = {
            type: 'AssignmentPattern',
            left: identifier,
            right: delegate.parseAssignmentExpr(),
            start: identifier.start,
            end: delegate.lastEnd(),
          }
        }

        properties.push({
          type: 'Property',
          key,
          value,
          kind: 'init',
          method: false,
          computed: false,
          shorthand: true,
          start: keyTok.start,
          end: delegate.lastEnd(),
        })
      }
    }

    if (delegate.peek()?.kind === 'op' && delegate.peek()!.value === ',') delegate.advance()
    else break
  }

  delegate.expectOp('}', 'Expected `}` after object binding pattern')
  return {
    type: 'ObjectPattern',
    properties,
    start: open.start,
    end: delegate.lastEnd(),
  }
}

function bindingIdentifierFromToken(delegate: ParserBindingDelegate, token: JSToken): Identifier {
  if (token.kind !== 'identifier') {
    throw new JSParseError('Expected parameter name', token, delegate.src)
  }
  if (FORBIDDEN_ARROW_BINDING_IDENTIFIERS.has(token.value)) {
    throw new JSParseError(
      `'${token.value}' is not allowed in arrow parameters`,
      token,
      delegate.src,
    )
  }
  return { type: 'Identifier', name: token.value, start: token.start, end: token.end }
}

function tokenToPropertyKeyNode(token: JSToken): ExpressionNode {
  const offsets = { start: token.start, end: token.end }
  if (token.kind === 'string') {
    return {
      type: 'Literal',
      value: parseStringValue(token.value),
      raw: token.value,
      ...offsets,
    }
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

function findMatchingParenIndex(tokens: readonly JSToken[], startIndex: number): number {
  let depth = 0

  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.kind !== 'op') continue
    if (token.value === '(') depth += 1
    else if (token.value === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }

  return -1
}
