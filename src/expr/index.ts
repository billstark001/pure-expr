import {
  type EvaluationInput,
  type EvaluationTransactionResult,
  type JSEvalOptions,
  JSEvaluator,
} from './evaluator.js'
import { JSLexer, type JSToken } from './lexer/index.js'
import type { BindingPattern, ExpressionNode } from './node-types.js'
import { JSExpressionParser, JSParseError, type JSParserOptions } from './parser.js'

export interface EvalOptions extends JSParserOptions, JSEvalOptions {}

export { defaultCallPermissionPolicy } from './call-permission.js'
export {
  allowAllCalls,
  type BindingStore,
  type ContextFreeze,
  type ContextInputMode,
  type ContextIsolation,
  type ContextPolicy,
  type ContextWriteMode,
  createBindingStore,
  createEvaluationEnvironment,
  type EvaluationEnvironment,
  type EvaluationEnvironmentInit,
  type EvaluationInput,
  type EvaluationTransactionResult,
  type FunctionMode,
  inheritedPropertyAccess,
  type JSCallKind,
  type JSCallPermissionContext,
  type JSCallPermissionPolicy,
  JSEvalError,
  type JSEvalOptions,
  JSEvaluator,
  type ObjectLiteralMode,
  ownPropertyAccess,
  type PropertyAccessContext,
  type PropertyAccessKind,
  type PropertyAccessPolicy,
  type TaggedTemplateArrayMode,
} from './evaluator.js'
export {
  cookTemplate,
  JSLexError,
  JSLexer,
  type JSLexerOptions,
  type JSLexerRule,
  type JSNumberOptions,
  type JSToken,
  type JSTokenKind,
  type NumberRadix,
  type TemplateQuasi,
} from './lexer/index.js'
export type {
  ArrayExpression,
  ArrayPattern,
  ArrowFunctionExpression,
  AssignmentExpression,
  AssignmentPattern,
  AssignmentProperty,
  AssignmentTarget,
  AstNode,
  AwaitExpression,
  BinaryExpression,
  BindingPattern,
  CallExpression,
  ChainExpression,
  ConditionalExpression,
  ExpressionNode,
  Identifier,
  Literal,
  LogicalExpression,
  MemberExpression,
  ObjectExpression,
  ObjectPattern,
  PipelineExpression,
  Property,
  RestElement,
  SequenceExpression,
  SpreadElement,
  TaggedTemplateExpression,
  TemplateElement,
  TemplateLiteral,
  TopicReference,
  UnaryExpression,
  UpdateExpression,
} from './node-types.js'
export {
  JSExpressionParser,
  type JSLocationOptions,
  JSParseError,
  type JSParserOptions,
} from './parser.js'

export interface CompiledExpression {
  readonly source: string
  readonly ast: ExpressionNode
  evaluate(context?: EvaluationInput): unknown
}

export interface TransactionalCompiledExpression {
  readonly source: string
  readonly ast: ExpressionNode
  evaluate(context?: EvaluationInput): EvaluationTransactionResult
}

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

function validateAstBudget(ast: ExpressionNode, options: JSParserOptions): void {
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

  const visitBinding = (binding: BindingPattern, depth: number): void => {
    bumpBudget(depth)
    switch (binding.type) {
      case 'Identifier':
        return
      case 'AssignmentPattern':
        visitBinding(binding.left, depth + 1)
        visit(binding.right, depth + 1)
        return
      case 'RestElement':
        visitBinding(binding.argument, depth + 1)
        return
      case 'ArrayPattern':
        for (const element of binding.elements) {
          if (element) visitBinding(element, depth + 1)
        }
        return
      case 'ObjectPattern':
        for (const property of binding.properties) {
          bumpBudget(depth + 1)
          if (property.type === 'RestElement') visitBinding(property.argument, depth + 2)
          else {
            if (property.computed) visit(property.key, depth + 2)
            visitBinding(property.value, depth + 2)
          }
        }
        return
    }
  }

  const visit = (node: ExpressionNode, depth: number): void => {
    bumpBudget(depth)
    switch (node.type) {
      case 'Literal':
      case 'Identifier':
      case 'TopicReference':
        return
      case 'ArrowFunctionExpression':
        for (const param of node.params) visitBinding(param, depth + 1)
        visit(node.body, depth + 1)
        return
      case 'AssignmentExpression':
        visit(node.left, depth + 1)
        visit(node.right, depth + 1)
        return
      case 'UpdateExpression':
        visit(node.argument, depth + 1)
        return
      case 'UnaryExpression':
      case 'AwaitExpression':
        visit(node.argument, depth + 1)
        return
      case 'BinaryExpression':
      case 'LogicalExpression':
      case 'PipelineExpression':
        visit(node.left, depth + 1)
        visit(node.right, depth + 1)
        return
      case 'ConditionalExpression':
        visit(node.test, depth + 1)
        visit(node.consequent, depth + 1)
        visit(node.alternate, depth + 1)
        return
      case 'MemberExpression':
        visit(node.object, depth + 1)
        visit(node.property, depth + 1)
        return
      case 'CallExpression':
        if (
          options.maxCallArguments !== undefined &&
          node.arguments.length > options.maxCallArguments
        ) {
          throw new JSParseError(
            `Expression exceeds maximum call argument count (${options.maxCallArguments})`,
          )
        }
        visit(node.callee, depth + 1)
        for (const argument of node.arguments) visit(argument, depth + 1)
        return
      case 'ChainExpression':
        visit(node.expression, depth + 1)
        return
      case 'ArrayExpression':
        if (
          options.maxArrayElements !== undefined &&
          node.elements.length > options.maxArrayElements
        ) {
          throw new JSParseError(
            `Expression exceeds maximum array element count (${options.maxArrayElements})`,
          )
        }
        for (const element of node.elements) {
          if (element) visit(element, depth + 1)
        }
        return
      case 'ObjectExpression':
        if (
          options.maxObjectProperties !== undefined &&
          node.properties.length > options.maxObjectProperties
        ) {
          throw new JSParseError(
            `Expression exceeds maximum object property count (${options.maxObjectProperties})`,
          )
        }
        for (const property of node.properties) {
          if (property.type === 'SpreadElement') visit(property.argument, depth + 1)
          else {
            visit(property.key, depth + 1)
            visit(property.value, depth + 1)
          }
        }
        return
      case 'SpreadElement':
        visit(node.argument, depth + 1)
        return
      case 'TemplateLiteral':
        if (
          options.maxTemplateExpressions !== undefined &&
          node.expressions.length > options.maxTemplateExpressions
        ) {
          throw new JSParseError(
            `Expression exceeds maximum template expression count (${options.maxTemplateExpressions})`,
          )
        }
        for (const expression of node.expressions) visit(expression, depth + 1)
        return
      case 'TaggedTemplateExpression':
        visit(node.tag, depth + 1)
        visit(node.quasi, depth + 1)
        return
      case 'SequenceExpression':
        for (const expression of node.expressions) visit(expression, depth + 1)
        return
    }
  }

  visit(ast, 1)
}

export function parseExpression(expression: string, options: JSParserOptions = {}): ExpressionNode {
  validateSourceLength(expression, options)
  const tokens = tokenizeExpression(expression, options)
  const parser = new JSExpressionParser(tokens, options, expression)
  const ast = parser.parse()
  validateAstBudget(ast, options)
  return ast
}

export function compileExpression(
  expression: string,
  options: EvalOptions & { writes: 'transaction' },
): TransactionalCompiledExpression
export function compileExpression(expression: string, options?: EvalOptions): CompiledExpression
export function compileExpression(
  expression: string,
  options: EvalOptions = {},
): CompiledExpression | TransactionalCompiledExpression {
  const ast = parseExpression(expression, parserOptionsForEvaluation(options))
  const evaluator = new JSEvaluator(undefined, options)
  const execute = evaluator.compile(ast)
  return {
    source: expression,
    ast,
    evaluate(context: EvaluationInput = {}) {
      return execute(context)
    },
  }
}

export const compile = compileExpression

export function evaluate(
  expression: string,
  context: EvaluationInput,
  options: EvalOptions & { writes: 'transaction' },
): EvaluationTransactionResult
export function evaluate(
  expression: string,
  context?: EvaluationInput,
  options?: EvalOptions,
): unknown
export function evaluate(
  expression: string,
  context: EvaluationInput = {},
  options: EvalOptions = {},
): unknown {
  const ast = parseExpression(expression, parserOptionsForEvaluation(options))
  return new JSEvaluator(context, options).evaluate(ast)
}

export function createEvaluator(
  options: EvalOptions & { writes: 'transaction' },
): (expression: string, context?: EvaluationInput) => EvaluationTransactionResult
export function createEvaluator(
  options?: EvalOptions,
): (expression: string, context?: EvaluationInput) => unknown
export function createEvaluator(options: EvalOptions = {}) {
  const evaluator = new JSEvaluator(undefined, options)
  return (expression: string, context: EvaluationInput = {}) =>
    evaluator.evaluate(parseExpression(expression, parserOptionsForEvaluation(options)), context)
}

function parserOptionsForEvaluation(options: EvalOptions): EvalOptions {
  if (options.allowAssignments !== undefined || !options.writes || options.writes === 'deny') {
    return options
  }
  return { ...options, allowAssignments: true }
}
