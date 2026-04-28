import { type JSEvalOptions, JSEvaluator } from './evaluator.js'
import { JSLexer, type JSToken } from './lexer.js'
import type { JSBindingNode, JSExprNode } from './node-types.js'
import { type JSParserOptions, JSExpressionParser, JSParseError } from './parser.js'

// #region Shared public types

/** Options shared by parsing and evaluation helpers. */
export interface EvalOptions extends JSParserOptions, JSEvalOptions {}

// #endregion

// #region Re-exports

export { defaultCallPermissionPolicy } from './call-permission.js'
export { JSExpressionParser, type JSParserOptions, JSParseError } from './parser.js'
export {
  allowAllCalls,
  type FunctionMode,
  JSEvaluator,
  type JSCallKind,
  type JSCallPermissionContext,
  type JSCallPermissionPolicy,
  type JSEvalOptions,
  type ObjectLiteralMode,
  type RootContextMode,
  type TaggedTemplateArrayMode,
  JSEvalError,
} from './evaluator.js'
export {
  JSLexer,
  type JSToken,
  type JSTokenKind,
  type TemplateQuasi,
  JSLexError,
  cookTemplate,
} from './lexer.js'

export type {
  JSExprNode,
  JSLiteralNode,
  JSRegexNode,
  JSIdentifierNode,
  JSTopicReferenceNode,
  JSBindingNode,
  JSBindingIdentifierNode,
  JSBindingAssignmentNode,
  JSBindingArrayNode,
  JSBindingPropertyNode,
  JSBindingObjectNode,
  JSArrowParameterNode,
  JSArrowFunctionNode,
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
} from './node-types.js'

// #endregion

// #region Validation helpers

/** Parsed expression that can be evaluated repeatedly with different scopes. */
export interface CompiledExpression {
  readonly source: string
  readonly ast: JSExprNode
  evaluate(context?: Record<string, unknown>): unknown
}

/** Tokenize an expression source string. */
export function tokenizeExpression(
  expression: string,
  options: Pick<JSParserOptions, 'maxSourceLength'> = {},
): JSToken[] {
  validateSourceLength(expression, options)
  return new JSLexer(expression).tokenize()
}

function validateSourceLength(
  expression: string,
  options: Pick<JSParserOptions, 'maxSourceLength'>,
): void {
  const max = options.maxSourceLength
  if (max !== undefined && expression.length > max) {
    throw new JSParseError(`Expression exceeds maximum source length (${max})`)
  }
}

function validateAstBudget(ast: JSExprNode, options: JSParserOptions): void {
  let nodeCount = 0

  const bumpBudget = (depth: number): void => {
    nodeCount += 1

    if (options.maxAstNodes !== undefined && nodeCount > options.maxAstNodes) {
      throw new JSParseError(`Expression exceeds maximum AST node count (${options.maxAstNodes})`)
    }
    if (options.maxAstDepth !== undefined && depth > options.maxAstDepth) {
      throw new JSParseError(`Expression exceeds maximum AST depth (${options.maxAstDepth})`)
    }
  }

  const visitBinding = (binding: JSBindingNode, depth: number): void => {
    bumpBudget(depth)

    switch (binding.type) {
      case 'binding-identifier':
        return

      case 'binding-assignment':
        visitBinding(binding.left, depth + 1)
        visit(binding.defaultValue, depth + 1)
        return

      case 'binding-array':
        for (const element of binding.elements) {
          if (element !== null) visitBinding(element, depth + 1)
        }
        if (binding.rest) visitBinding(binding.rest, depth + 1)
        return

      case 'binding-object':
        for (const prop of binding.properties) {
          bumpBudget(depth + 1)
          if (prop.computed) visit(prop.key, depth + 2)
          visitBinding(prop.value, depth + 2)
        }
        if (binding.rest) visitBinding(binding.rest, depth + 1)
        return
    }
  }

  const visit = (node: JSExprNode, depth: number): void => {
    bumpBudget(depth)

    switch (node.type) {
      case 'literal':
      case 'regex':
      case 'identifier':
      case 'topic':
        return

      case 'arrow-function':
        for (const param of node.params) {
          bumpBudget(depth + 1)
          visitBinding(param.binding, depth + 2)
        }
        visit(node.body, depth + 1)
        return

      case 'unary':
        visit(node.operand, depth + 1)
        return

      case 'binary':
      case 'logical':
      case 'pipeline':
        visit(node.left, depth + 1)
        visit(node.right, depth + 1)
        return

      case 'conditional':
        visit(node.test, depth + 1)
        visit(node.consequent, depth + 1)
        visit(node.alternate, depth + 1)
        return

      case 'member':
        visit(node.object, depth + 1)
        visit(node.property, depth + 1)
        return

      case 'call':
        if (options.maxCallArguments !== undefined && node.args.length > options.maxCallArguments) {
          throw new JSParseError(
            `Expression exceeds maximum call argument count (${options.maxCallArguments})`,
          )
        }
        visit(node.callee, depth + 1)
        for (const arg of node.args) visit(arg, depth + 1)
        return

      case 'array':
        if (
          options.maxArrayElements !== undefined &&
          node.elements.length > options.maxArrayElements
        ) {
          throw new JSParseError(
            `Expression exceeds maximum array element count (${options.maxArrayElements})`,
          )
        }
        for (const element of node.elements) {
          if (element !== null) visit(element, depth + 1)
        }
        return

      case 'object':
        if (
          options.maxObjectProperties !== undefined &&
          node.props.length > options.maxObjectProperties
        ) {
          throw new JSParseError(
            `Expression exceeds maximum object property count (${options.maxObjectProperties})`,
          )
        }
        for (const prop of node.props) {
          if (prop.type === 'spread') {
            visit(prop.argument, depth + 1)
          } else {
            visit(prop.key, depth + 1)
            visit(prop.value, depth + 1)
          }
        }
        return

      case 'spread':
        visit(node.argument, depth + 1)
        return

      case 'template':
        if (
          options.maxTemplateExpressions !== undefined &&
          node.expressions.length > options.maxTemplateExpressions
        ) {
          throw new JSParseError(
            `Expression exceeds maximum template expression count (${options.maxTemplateExpressions})`,
          )
        }
        if (node.tag) visit(node.tag, depth + 1)
        for (const expression of node.expressions) visit(expression, depth + 1)
        return

      case 'sequence':
        for (const expression of node.expressions) visit(expression, depth + 1)
        return

      default: {
        const exhaustive: never = node
        throw new JSParseError(`Unknown AST node type: ${(exhaustive as any).type}`)
      }
    }
  }

  visit(ast, 1)
}

// #endregion

// #region Public expression helpers

/** Parse an expression source string into an AST. */
export function parseExpression(expression: string, options: JSParserOptions = {}): JSExprNode {
  validateSourceLength(expression, options)
  const tokens = tokenizeExpression(expression, options)
  const parser = new JSExpressionParser(tokens, options, expression)
  const ast = parser.parse()
  validateAstBudget(ast, options)
  return ast
}

/** Compile an expression once and evaluate it repeatedly with different scopes. */
export function compileExpression(
  expression: string,
  options: EvalOptions = {},
): CompiledExpression {
  const ast = parseExpression(expression, options)
  const evaluator = new JSEvaluator({}, options)

  return {
    source: expression,
    ast,
    evaluate(context: Record<string, unknown> = {}) {
      return evaluator.evaluate(ast, context)
    },
  }
}

/** Alias for compileExpression(...) with a shorter name. */
export const compile = compileExpression

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
  options: EvalOptions = {},
): unknown {
  const ast = parseExpression(expression, options)
  const evaluator = new JSEvaluator(context, options)
  return evaluator.evaluate(ast)
}

/**
 * Create a reusable evaluator bound to fixed options.
 * Useful when the same options are used across many evaluations.
 */
export function createEvaluator(options: EvalOptions = {}) {
  const evaluator = new JSEvaluator({}, options)

  return (expression: string, context: Record<string, unknown> = {}) => {
    const ast = parseExpression(expression, options)
    return evaluator.evaluate(ast, context)
  }
}

// #endregion
