import type { JSToken } from '../lexer/types.js'
import type { ExpressionNode, TemplateLiteral } from '../node-types.js'
import { JSParseError } from './errors.js'

export function buildTemplateAstNode(
  tok: JSToken,
  tagged: boolean,
  src: string,
  parseExpressionTokens: (exprTokens: JSToken[]) => ExpressionNode,
): TemplateLiteral {
  const data = tok.tmpl!
  if (!tagged && data.quasis.some((quasi) => quasi.cooked === null)) {
    throw new JSParseError('Invalid escape sequence in template literal', tok, src)
  }

  const expressions = data.exprTokens.map((exprTokens, index) => {
    try {
      return parseExpressionTokens(exprTokens)
    } catch (error) {
      if (error instanceof JSParseError) throw error
      throw new JSParseError(
        `Error in template expression #${index + 1}: ${(error as Error).message}`,
        tok,
        src,
      )
    }
  })

  return {
    type: 'TemplateLiteral',
    quasis: data.quasis.map((quasi, index) => ({
      type: 'TemplateElement',
      tail: index === data.quasis.length - 1,
      value: quasi,
    })),
    expressions,
    start: tok.start,
    end: tok.end,
  }
}
