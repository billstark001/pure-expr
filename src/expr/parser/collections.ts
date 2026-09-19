import type { JSToken } from '../lexer/index.js'
import { JSIncompleteParseError, JSParseError } from './errors.js'
import type {
  ArrayExpression,
  ExpressionNode,
  ObjectExpression,
  Property,
  SpreadElement,
} from './node-types.js'
import { propertyKeyFromToken } from './shared.js'

export interface CollectionParserDelegate {
  readonly src: string
  peek(offset?: number): JSToken | undefined
  advance(): JSToken | undefined
  lastEnd(): number
  expectOp(raw: string, message?: string): JSToken
  parseAssignmentExpr(): ExpressionNode
  parseSequenceExpr(): ExpressionNode
}

export function parseArrayLiteral(
  parser: CollectionParserDelegate,
  opening: JSToken,
): ArrayExpression {
  parser.advance()
  const elements: Array<ExpressionNode | SpreadElement | null> = []
  while (parser.peek()?.value !== ']') {
    if (!parser.peek()) {
      throw new JSIncompleteParseError('Unterminated array literal', opening, parser.src)
    }
    if (parser.peek()!.value === ',') {
      parser.advance()
      elements.push(null)
      continue
    }
    if (parser.peek()!.value === '...') {
      const spread = parser.advance()!
      elements.push({
        type: 'SpreadElement',
        argument: parser.parseAssignmentExpr(),
        start: spread.start,
        end: parser.lastEnd(),
      })
    } else {
      elements.push(parser.parseAssignmentExpr())
    }
    if (parser.peek()?.value === ',') parser.advance()
    else break
  }
  parser.expectOp(']', 'Unterminated array literal, expected ]')
  return {
    type: 'ArrayExpression',
    elements,
    start: opening.start,
    end: parser.lastEnd(),
  }
}

export function parseObjectLiteral(
  parser: CollectionParserDelegate,
  opening: JSToken,
): ObjectExpression {
  parser.advance()
  const properties: Array<Property | SpreadElement> = []
  while (parser.peek()?.value !== '}') {
    if (!parser.peek()) {
      throw new JSIncompleteParseError('Unterminated object literal', opening, parser.src)
    }

    if (parser.peek()!.value === '...') {
      const spread = parser.advance()!
      properties.push({
        type: 'SpreadElement',
        argument: parser.parseAssignmentExpr(),
        start: spread.start,
        end: parser.lastEnd(),
      })
      if (parser.peek()?.value === ',') parser.advance()
      continue
    }

    if (parser.peek()!.value === '[') {
      const bracket = parser.advance()!
      const key = parser.parseSequenceExpr()
      parser.expectOp(']')
      parser.expectOp(':', 'Expected : after computed object key')
      const value = parser.parseAssignmentExpr()
      properties.push({
        type: 'Property',
        key,
        value,
        kind: 'init',
        method: false,
        computed: true,
        shorthand: false,
        start: bracket.start,
        end: parser.lastEnd(),
      })
    } else {
      const keyToken = parser.advance()
      if (!keyToken) {
        throw new JSIncompleteParseError('Expected property key', undefined, parser.src)
      }
      const key = propertyKeyFromToken(keyToken)

      if (parser.peek()?.value === ':') {
        parser.advance()
        const value = parser.parseAssignmentExpr()
        properties.push({
          type: 'Property',
          key,
          value,
          kind: 'init',
          method: false,
          computed: false,
          shorthand: false,
          start: keyToken.start,
          end: parser.lastEnd(),
        })
      } else {
        if (keyToken.kind !== 'identifier') {
          throw new JSParseError(
            `Expected ':' after object key '${keyToken.value}'`,
            keyToken,
            parser.src,
          )
        }
        properties.push({
          type: 'Property',
          key,
          value: {
            type: 'Identifier',
            name: keyToken.value,
            start: keyToken.start,
            end: keyToken.end,
          },
          kind: 'init',
          method: false,
          computed: false,
          shorthand: true,
          start: keyToken.start,
          end: keyToken.end,
        })
      }
    }
    if (parser.peek()?.value === ',') parser.advance()
    else break
  }
  parser.expectOp('}', 'Unterminated object literal, expected }')
  return {
    type: 'ObjectExpression',
    properties,
    start: opening.start,
    end: parser.lastEnd(),
  }
}
