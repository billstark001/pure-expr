import type { JSToken } from '../lexer.js'
import type { JSExprNode, JSTemplateNode } from '../node-types.js'
import { JSParseError } from './errors.js'

export function buildTemplateAstNode(
  tok: JSToken,
  tag: JSExprNode | null,
  src: string,
  parseExpressionTokens: (exprTokens: JSToken[]) => JSExprNode,
): JSTemplateNode {
  const data = tok.tmpl!
  if (!tag && data.quasis.some((quasi) => quasi.cooked === null)) {
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
    type: 'template',
    tag,
    quasis: data.quasis,
    expressions,
    start: tok.start,
    end: tok.end,
  }
}
