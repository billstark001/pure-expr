import { JSEvalOptions, JSEvaluator } from "./evaluator.js"
import { JSLexer } from "./lexer.js"
import { JSParserOptions, JSExpressionParser } from "./parser.js"

export interface EvalOptions extends JSParserOptions, JSEvalOptions {}

export { JSExpressionParser, type JSParserOptions, JSParseError } from "./parser.js"
export { JSEvaluator, type JSEvalOptions, JSEvalError } from "./evaluator.js"
export { JSLexer, type JSToken, type JSTokenKind, JSLexError } from "./lexer.js"

export type {
  JSExprNode,
  JSIdentifierNode,
  JSMemberNode,
  JSCallNode,
  JSConditionalNode,
  JSBinaryNode,
  JSLogicalNode,
  JSPipelineNode,
  JSSpreadNode,
  JSObjectPropNode,
  JSTemplateNode,
} from "./node-types.js"

/**
 * Parse and evaluate a JS expression string in a readonly context.
 *
 * @param expression  The JS expression source string.
 * @param context     A plain object of variables available to the expression.
 * @param options     Parser/evaluator options (allowAwait, allowIn, maxCallDepth).
 * @returns           The result of the expression.
 *
 * @throws {JSLexError}    On tokenization errors (bad characters, unterminated literals).
 * @throws {JSParseError}  On syntax errors, with precise position info.
 * @throws {JSEvalError}   On runtime errors (undefined var, type error, sandbox violation).
 */
export function evaluate(
  expression: string,
  context: Record<string, unknown> = {},
  options: EvalOptions = {}
): unknown {
  const lexer = new JSLexer(expression)
  const tokens = lexer.tokenize()
  const parser = new JSExpressionParser(tokens, options, expression)
  const ast = parser.parse()
  const evaluator = new JSEvaluator(context, options)
  return evaluator.eval(ast)
}

/**
 * Create a reusable evaluator bound to fixed options.
 * Useful when the same options are used across many evaluations.
 */
export function createEvaluator(options: EvalOptions = {}) {
  return (expression: string, context: Record<string, unknown> = {}) =>
    evaluate(expression, context, options)
}