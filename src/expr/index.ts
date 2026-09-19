import { JSEvaluator } from './evaluator/runner.js'
import type {
  EvaluationInput,
  EvaluationTransactionResult,
  JSEvalOptions,
} from './evaluator/types.js'
import { JSLexer, type JSToken } from './lexer/index.js'
import type { BindingPattern, ExpressionNode } from './node-types.js'
import { JSParseError, type JSParserOptions } from './parser/errors.js'
import { JSExpressionParser } from './parser/parser.js'
import { collectScanTokens, type JSScanOptions, type JSScanStopReason } from './parser/scanner.js'

export interface EvalOptions extends JSParserOptions, JSEvalOptions {}

export { defaultCallPermissionPolicy } from './call-permission.js'
export { createBindingStore, createEvaluationEnvironment } from './evaluator/context.js'
export { inheritedPropertyAccess, ownPropertyAccess } from './evaluator/operations.js'
export { JSEvaluator } from './evaluator/runner.js'
export {
  allowAllCalls,
  type BindingStore,
  type ContextFreeze,
  type ContextInputMode,
  type ContextIsolation,
  type ContextPolicy,
  type ContextWriteMode,
  type EvaluationEnvironment,
  type EvaluationEnvironmentInit,
  type EvaluationInput,
  type EvaluationTransactionResult,
  type FunctionMode,
  type JSCallKind,
  type JSCallPermissionContext,
  type JSCallPermissionPolicy,
  JSEvalError,
  type JSEvalOptions,
  type ObjectLiteralMode,
  type PropertyAccessContext,
  type PropertyAccessKind,
  type PropertyAccessPolicy,
  type TaggedTemplateArrayMode,
} from './evaluator/types.js'
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
  JSIncompleteParseError,
  type JSLocationOptions,
  JSParseError,
  type JSParserOptions,
} from './parser/errors.js'
export {
  type JSBindingPrefixResult,
  JSExpressionParser,
  type JSExpressionPrefixResult,
} from './parser/parser.js'
export type {
  JSIncompleteBehavior,
  JSScanBoundary,
  JSScanBoundaryContext,
  JSScanOptions,
  JSScanProfile,
  JSScanStopReason,
} from './parser/scanner.js'

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

export interface ExpressionScanResult {
  readonly expression: ExpressionNode
  readonly start: number
  readonly end: number
  readonly next: number
  readonly stoppedBy: JSScanStopReason
}

export interface BindingPatternScanResult {
  readonly pattern: BindingPattern
  readonly start: number
  readonly end: number
  readonly next: number
  readonly stoppedBy: JSScanStopReason
}

export interface IterationClause {
  readonly binding: BindingPattern
  readonly iterable: ExpressionNode
  readonly start: number
  readonly end: number
  readonly separatorStart: number
  readonly separatorEnd: number
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

function validateSyntaxBudget(
  ast: ExpressionNode | BindingPattern,
  options: JSParserOptions,
  rootKind: 'expression' | 'binding',
): void {
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

  if (rootKind === 'expression') visit(ast as ExpressionNode, 1)
  else visitBinding(ast as BindingPattern, 1)
}

export function parseExpression(expression: string, options: JSParserOptions = {}): ExpressionNode {
  validateSourceLength(expression, options)
  const tokens = tokenizeExpression(expression, options)
  const parser = new JSExpressionParser(tokens, options, expression)
  const ast = parser.parse()
  validateSyntaxBudget(ast, options, 'expression')
  return ast
}

/** Parse one complete ESTree binding pattern and require full source consumption. */
export function parseBindingPattern(source: string, options: JSParserOptions = {}): BindingPattern {
  validateSourceLength(source, options)
  const tokens = tokenizeExpression(source, options)
  const pattern = new JSExpressionParser(tokens, options, source).parseBindingPattern()
  validateSyntaxBudget(pattern, options, 'binding')
  return pattern
}

/** Scan one expression prefix from a larger host-language source string. */
export function scanExpression(source: string, options: JSScanOptions = {}): ExpressionScanResult {
  const collected = collectScanTokens(source, options)
  const parsed = new JSExpressionParser(collected.tokens, options, source).parsePrefix(
    options.incomplete ?? 'error',
  )
  validateSyntaxBudget(parsed.expression, options, 'expression')
  const next = parsed.nextToken?.start ?? collected.boundaryOffset
  return {
    expression: parsed.expression,
    start: collected.tokens[0]?.start ?? options.start ?? 0,
    end: parsed.end,
    next,
    stoppedBy: parsed.rolledBack
      ? 'incomplete'
      : parsed.nextToken
        ? 'syntax'
        : collected.stoppedAtBoundary
          ? 'boundary'
          : 'end',
  }
}

/** Scan one binding-pattern prefix from a larger host-language source string. */
export function scanBindingPattern(
  source: string,
  options: JSScanOptions = {},
): BindingPatternScanResult {
  const collected = collectScanTokens(source, options)
  const parsed = new JSExpressionParser(collected.tokens, options, source).parseBindingPrefix(
    options.incomplete ?? 'error',
  )
  validateSyntaxBudget(parsed.pattern, options, 'binding')
  const next = parsed.nextToken?.start ?? collected.boundaryOffset
  return {
    pattern: parsed.pattern,
    start: collected.tokens[0]?.start ?? options.start ?? 0,
    end: parsed.end,
    next,
    stoppedBy: parsed.rolledBack
      ? 'incomplete'
      : parsed.nextToken
        ? 'syntax'
        : collected.stoppedAtBoundary
          ? 'boundary'
          : 'end',
  }
}

/** Parse a DSL iteration clause shaped like `<binding> of <expression>`. */
export function parseIterationClause(
  source: string,
  options: JSParserOptions = {},
): IterationClause {
  validateSourceLength(source, options)
  const scannedBinding = scanBindingPattern(source, {
    ...options,
    boundary: ({ token, depth }) =>
      depth === 0 && token.kind === 'identifier' && token.value === 'of',
  })
  const separatorLexer = new JSLexer(source, { start: scannedBinding.next })
  const separator = separatorLexer.nextToken()
  if (separator?.kind !== 'identifier' || separator.value !== 'of') {
    throw new JSParseError(
      "Expected contextual keyword 'of' after binding pattern",
      separator,
      source,
    )
  }

  const iterableLexer = new JSLexer(source, { start: separator.end })
  const iterableTokens = iterableLexer.tokenize()
  if (iterableTokens.length === 0) {
    throw new JSParseError("Expected expression after contextual keyword 'of'", separator, source)
  }
  const iterable = new JSExpressionParser(iterableTokens, options, source).parse()
  validateSyntaxBudget(iterable, options, 'expression')

  return {
    binding: scannedBinding.pattern,
    iterable,
    start: scannedBinding.start,
    end: iterableTokens[iterableTokens.length - 1].end,
    separatorStart: separator.start,
    separatorEnd: separator.end,
  }
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
