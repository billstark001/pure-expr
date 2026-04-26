import { JSEvalOptions, JSEvaluator } from "./evaluator.js"
import { JSLexer, type JSToken } from "./lexer.js"
import { type JSExprNode } from "./node-types.js"
import { JSParserOptions, JSExpressionParser } from "./parser.js"

/** Options shared by parsing and evaluation helpers. */
export interface EvalOptions extends JSParserOptions, JSEvalOptions {}

export { JSExpressionParser, type JSParserOptions, JSParseError } from "./parser.js"
export { JSEvaluator, type JSEvalOptions, JSEvalError } from "./evaluator.js"
export {
  JSLexer,
  type JSToken,
  type JSTokenKind,
  type TemplateQuasi,
  JSLexError,
  cookTemplate,
} from "./lexer.js"
export {
  PrattParser,
  PrattParseError,
  type PrattToken,
  type PrattOperatorToken,
  type PrattExprToken,
  type PrattASTNode,
  type LeafNode,
  type PrefixNode,
  type PostfixNode,
  type BinaryNode as PrattBinaryNode,
  type Associativity,
  type OperatorConfig,
  type OperatorValidator,
  type PrattParserConfig,
} from "./pratt-parser.js"

export type {
  JSExprNode,
  JSLiteralNode,
  JSRegexNode,
  JSIdentifierNode,
  JSUnaryNode,
  JSMemberNode,
  JSCallNode,
  JSConditionalNode,
  JSBinaryNode,
  JSLogicalNode,
  JSArrayNode,
  JSObjectNode,
  JSPipelineNode,
  JSSpreadNode,
  JSObjectPropNode,
  JSTemplateNode,
  JSSequenceNode,
} from "./node-types.js"

/** Parsed expression that can be evaluated repeatedly with different scopes. */
export interface CompiledExpression {
  readonly source: string
  readonly ast: JSExprNode
  evaluate(context?: Record<string, unknown>): unknown
}

/** Tokenize an expression source string. */
export function tokenizeExpression(expression: string): JSToken[] {
  return new JSLexer(expression).tokenize()
}

/** Parse an expression source string into an AST. */
export function parseExpression(
  expression: string,
  options: JSParserOptions = {}
): JSExprNode {
  const tokens = tokenizeExpression(expression)
  const parser = new JSExpressionParser(tokens, options, expression)
  return parser.parse()
}

/** Compile an expression once and evaluate it repeatedly with different scopes. */
export function compileExpression(
  expression: string,
  options: EvalOptions = {}
): CompiledExpression {
  const ast = parseExpression(expression, options)

  return {
    source: expression,
    ast,
    evaluate(context: Record<string, unknown> = {}) {
      const evaluator = new JSEvaluator(context, options)
      return evaluator.eval(ast)
    },
  }
}

/**
 * Parse and evaluate a JS expression string in a readonly context.
 *
 * @param expression The JS expression source string.
 * @param context A plain object of variables available to the expression.
 * @param options Parser/evaluator options.
 * @returns The result of the expression.
 *
 * @throws {JSLexError} On tokenization errors.
 * @throws {JSParseError} On syntax errors.
 * @throws {JSEvalError} On runtime errors.
 */
export function evaluate(
  expression: string,
  context: Record<string, unknown> = {},
  options: EvalOptions = {}
): unknown {
  const ast = parseExpression(expression, options)
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