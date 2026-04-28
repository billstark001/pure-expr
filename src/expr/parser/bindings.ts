import type { JSToken, JSTokenKind } from '../lexer.js'
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
} from '../node-types.js'
import { JSParseError, type JSParserOptions } from './errors.js'
import { FORBIDDEN_ARROW_BINDING_IDENTIFIERS } from './grammar.js'
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
  parseAssignmentExpr(): JSExprNode
  parseSequenceExpr(): JSExprNode
  hasLineTerminatorBetween(start: number | undefined, end: number | undefined): boolean
}

// #region Arrow helpers

export function isArrowFunctionStart(delegate: ParserBindingDelegate): boolean {
  const start = delegate.peek()
  if (!start) return false

  if (start.kind === 'identifier') {
    const arrow = delegate.tokens[delegate.position + 1]
    return (
      arrow?.kind === 'op' &&
      arrow.raw === '=>' &&
      !delegate.hasLineTerminatorBetween(start.end, arrow.start)
    )
  }

  if (start.kind === 'op' && start.raw === '(') {
    const closeIndex = findMatchingParenIndex(delegate.tokens, delegate.position)
    if (closeIndex < 0) return false

    const close = delegate.tokens[closeIndex]
    const arrow = delegate.tokens[closeIndex + 1]
    return (
      close?.kind === 'op' &&
      close.raw === ')' &&
      arrow?.kind === 'op' &&
      arrow.raw === '=>' &&
      !delegate.hasLineTerminatorBetween(close.end, arrow.start)
    )
  }

  return false
}

export function parseArrowFunction(delegate: ParserBindingDelegate): JSArrowFunctionNode {
  if (delegate.opts.allowArrowFunctions === false) {
    throw new JSParseError(
      'Arrow functions are not enabled in this context',
      delegate.peek(),
      delegate.src,
    )
  }

  const start = delegate.peek()!
  let params: JSArrowParameterNode[]

  if (start.kind === 'identifier') {
    const param = bindingIdentifierFromToken(delegate, delegate.advance()!)
    delegate.expectOp('=>', 'Expected `=>` after arrow parameter')
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
    params = parseArrowParameterList(delegate)
    delegate.expectOp('=>', 'Expected `=>` after arrow parameters')
  }

  if (delegate.peek()?.kind === 'op' && delegate.peek()!.raw === '{') {
    throw new JSParseError(
      'Arrow functions with block bodies are not supported in this context',
      delegate.peek(),
      delegate.src,
    )
  }

  const body = delegate.parseAssignmentExpr()
  const node = {
    type: 'arrow-function',
    params,
    body,
    start: start.start,
    end: delegate.lastEnd(),
  } satisfies JSArrowFunctionNode

  validateArrowFunction(node, delegate.src)
  return node
}

// #endregion

// #region Binding parsing

function parseArrowParameterList(delegate: ParserBindingDelegate): JSArrowParameterNode[] {
  const open = delegate.expectOp('(')
  const params: JSArrowParameterNode[] = []

  if (delegate.peek()?.kind === 'op' && delegate.peek()!.raw === ')') {
    delegate.advance()
    return params
  }

  for (;;) {
    const start = delegate.peek()
    if (!start) throw new JSParseError('Unterminated arrow parameter list', open, delegate.src)

    let rest = false
    let binding: JSBindingNode

    if (start.kind === 'op' && start.raw === '...') {
      rest = true
      delegate.advance()
      binding = parseBindingPattern(delegate)
    } else {
      binding = parseBindingElement(delegate)
    }

    params.push({
      type: 'parameter',
      binding,
      rest,
      start: start.start,
      end: delegate.lastEnd(),
    })

    if (rest) break
    if (delegate.peek()?.kind !== 'op' || delegate.peek()!.raw !== ',') break
    delegate.advance()
    if (delegate.peek()?.kind === 'op' && delegate.peek()!.raw === ')') break
  }

  delegate.expectOp(')', 'Expected `)` after arrow parameters')
  return params
}

function parseBindingElement(delegate: ParserBindingDelegate): JSBindingNode {
  const binding = parseBindingPattern(delegate)
  if (delegate.peek()?.kind === 'op' && delegate.peek()!.raw === '=') {
    delegate.advance()
    return {
      type: 'binding-assignment',
      left: binding,
      defaultValue: delegate.parseAssignmentExpr(),
      start: binding.start,
      end: delegate.lastEnd(),
    } satisfies JSBindingAssignmentNode
  }
  return binding
}

function parseBindingPattern(delegate: ParserBindingDelegate): JSBindingNode {
  const token = delegate.peek()
  if (!token) {
    throw new JSParseError('Unexpected end of arrow parameter list', undefined, delegate.src)
  }

  if (token.kind === 'identifier') {
    return bindingIdentifierFromToken(delegate, delegate.advance()!)
  }
  if (token.kind === 'op' && token.raw === '[') return parseBindingArrayPattern(delegate)
  if (token.kind === 'op' && token.raw === '{') return parseBindingObjectPattern(delegate)

  throw new JSParseError(
    `Unexpected token '${token.raw}' in arrow parameter list`,
    token,
    delegate.src,
  )
}

function parseBindingArrayPattern(delegate: ParserBindingDelegate): JSBindingArrayNode {
  const open = delegate.expectOp('[')
  const elements: Array<JSBindingNode | null> = []
  let rest: JSBindingNode | null = null

  while (delegate.peek()?.kind !== 'op' || delegate.peek()!.raw !== ']') {
    if (!delegate.peek()) {
      throw new JSParseError('Unterminated array binding pattern', open, delegate.src)
    }
    if (delegate.peek()!.kind === 'op' && delegate.peek()!.raw === ',') {
      delegate.advance()
      elements.push(null)
      continue
    }
    if (delegate.peek()!.kind === 'op' && delegate.peek()!.raw === '...') {
      delegate.advance()
      rest = parseBindingPattern(delegate)
      break
    }

    elements.push(parseBindingElement(delegate))
    if (delegate.peek()?.kind === 'op' && delegate.peek()!.raw === ',') delegate.advance()
    else break
  }

  delegate.expectOp(']', 'Expected `]` after array binding pattern')
  return {
    type: 'binding-array',
    elements,
    rest,
    start: open.start,
    end: delegate.lastEnd(),
  }
}

function parseBindingObjectPattern(delegate: ParserBindingDelegate): JSBindingObjectNode {
  const open = delegate.expectOp('{')
  const properties: JSBindingPropertyNode[] = []
  let rest: JSBindingIdentifierNode | null = null

  while (delegate.peek()?.kind !== 'op' || delegate.peek()!.raw !== '}') {
    if (!delegate.peek()) {
      throw new JSParseError('Unterminated object binding pattern', open, delegate.src)
    }

    if (delegate.peek()!.kind === 'op' && delegate.peek()!.raw === '...') {
      const spread = delegate.advance()!
      rest = bindingIdentifierFromToken(
        delegate,
        delegate.expect('identifier', 'Expected identifier after object rest operator'),
      )
      rest.start = spread.start
      rest.end = delegate.lastEnd()
      break
    }

    if (delegate.peek()!.kind === 'op' && delegate.peek()!.raw === '[') {
      const openBracket = delegate.advance()!
      const key = delegate.parseSequenceExpr()
      delegate.expectOp(']')
      delegate.expectOp(':', 'Expected `:` after computed binding key')
      const value = parseBindingElement(delegate)
      properties.push({
        type: 'binding-property',
        key,
        value,
        computed: true,
        shorthand: false,
        start: openBracket.start,
        end: delegate.lastEnd(),
      })
    } else {
      const keyTok = delegate.advance()!
      const key = tokenToPropertyKeyNode(keyTok)

      if (delegate.peek()?.kind === 'op' && delegate.peek()!.raw === ':') {
        delegate.advance()
        properties.push({
          type: 'binding-property',
          key,
          value: parseBindingElement(delegate),
          computed: false,
          shorthand: false,
          start: keyTok.start,
          end: delegate.lastEnd(),
        })
      } else {
        if (keyTok.kind !== 'identifier') {
          throw new JSParseError(
            `Expected ':' after binding key '${keyTok.raw}'`,
            keyTok,
            delegate.src,
          )
        }

        const value = bindingIdentifierFromToken(delegate, keyTok)
        let binding: JSBindingNode = value

        if (delegate.peek()?.kind === 'op' && delegate.peek()!.raw === '=') {
          delegate.advance()
          binding = {
            type: 'binding-assignment',
            left: value,
            defaultValue: delegate.parseAssignmentExpr(),
            start: value.start,
            end: delegate.lastEnd(),
          } satisfies JSBindingAssignmentNode
        }

        properties.push({
          type: 'binding-property',
          key,
          value: binding,
          computed: false,
          shorthand: true,
          start: keyTok.start,
          end: delegate.lastEnd(),
        })
      }
    }

    if (delegate.peek()?.kind === 'op' && delegate.peek()!.raw === ',') delegate.advance()
    else break
  }

  delegate.expectOp('}', 'Expected `}` after object binding pattern')
  return {
    type: 'binding-object',
    properties,
    rest,
    start: open.start,
    end: delegate.lastEnd(),
  }
}

// #endregion

// #region Token helpers

function bindingIdentifierFromToken(
  delegate: ParserBindingDelegate,
  token: JSToken,
): JSBindingIdentifierNode {
  if (token.kind !== 'identifier') {
    throw new JSParseError('Expected parameter name', token, delegate.src)
  }
  if (FORBIDDEN_ARROW_BINDING_IDENTIFIERS.has(token.raw)) {
    throw new JSParseError(`'${token.raw}' is not allowed in arrow parameters`, token, delegate.src)
  }
  return { type: 'binding-identifier', name: token.raw, start: token.start, end: token.end }
}

function tokenToPropertyKeyNode(token: JSToken): JSExprNode {
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

function findMatchingParenIndex(tokens: readonly JSToken[], startIndex: number): number {
  let depth = 0

  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.kind !== 'op') continue
    if (token.raw === '(') depth += 1
    else if (token.raw === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }

  return -1
}

// #endregion
