import type { ArrowFunctionExpression, AstNode, ExpressionNode } from '../node-types.js'

/** Error raised while evaluating an expression AST. */
export class JSEvalError extends Error {
  constructor(
    message: string,
    public readonly node?: AstNode,
  ) {
    super(message)
    this.name = 'JSEvalError'
  }
}

export type TaggedTemplateArrayMode = 'spec' | 'loose'
export type FunctionMode = 'default' | 'performance'

export type RootContextMode =
  | 'allow'
  | 'copy-non-plain-to-null-prototype'
  | 'require-plain-object'
  | 'copy-plain-data-to-null-prototype'
export type ObjectLiteralMode = 'none' | 'filter-blocked' | 'plain-object-only' | 'safe'
export type JSCallKind = 'call' | 'pipeline' | 'tagged-template'
export type JSCallable = CallableFunction
export type PropertyAccessKind = 'property' | 'method'

export interface PropertyAccessContext {
  target: unknown
  key: string
  kind: PropertyAccessKind
  node: AstNode
}

export type PropertyAccessPolicy = (details: Readonly<PropertyAccessContext>) => unknown

export interface JSCallPermissionContext {
  kind: JSCallKind
  fn: JSCallable
  thisValue: unknown
  node: ExpressionNode
}

export type JSCallPermissionPolicy = (details: Readonly<JSCallPermissionContext>) => boolean

/** Permissive call policy that preserves legacy callable behavior. */
export const allowAllCalls: JSCallPermissionPolicy = () => true

export interface JSEvalOptions {
  allowAwait?: boolean
  allowIn?: boolean
  allowCalls?: boolean
  functionMode?: FunctionMode
  allowRegexLiterals?: boolean
  maxCallDepth?: number
  maxSteps?: number
  rootContextMode?: RootContextMode
  objectLiteralMode?: ObjectLiteralMode
  isCallableAllowed?: JSCallPermissionPolicy
  propertyAccess?: PropertyAccessPolicy
  taggedTemplateArrayMode?: TaggedTemplateArrayMode
}

export type EmulatedTemplateStringsArray = TemplateStringsArray & {
  raw: readonly string[]
}

export type CompiledNodeEvaluator = (state: EvalState) => unknown
export type CompiledArrowBinding = (value: unknown, state: EvalState) => void
export type CompiledKeyEvaluator = (state: EvalState) => string

export interface CompiledArgumentEvaluator {
  node: ExpressionNode
  spread: boolean
  execute: CompiledNodeEvaluator
}

export interface CompiledObjectPropertyEvaluator {
  spread: boolean
  key?: CompiledKeyEvaluator
  execute: CompiledNodeEvaluator
}

export interface CompiledArrowParameterEvaluator {
  rest: boolean
  bind: CompiledArrowBinding
}

export interface CompiledArrowRuntime {
  body: CompiledNodeEvaluator
  params: CompiledArrowParameterEvaluator[]
  boundNames: string[]
  expectedArgumentCount: number
}

export interface EvalState extends ExecutionBudget {
  context: Readonly<Record<string, unknown>>
  budget: ExecutionBudget
  topics: unknown[]
  opts: Readonly<JSEvalOptions>
}

export interface ExecutionBudget {
  callDepth: number
  steps: number
}

export const EMPTY_CONTEXT: Readonly<Record<string, unknown>> = Object.freeze({})
export const EMPTY_OPTS: Readonly<JSEvalOptions> = Object.freeze({})
export const UNINITIALIZED_ARROW_PARAM = Symbol('pure-expr.uninitialized-arrow-param')
export const PURE_EXPR_ARROW_BRAND = Symbol('pure-expr.arrow-function')
export const PERFORMANCE_ARROW_RUNTIME_CACHE = new WeakMap<
  ArrowFunctionExpression,
  CompiledArrowRuntime
>()

export const DEFAULT_ROOT_CONTEXT_MODE: RootContextMode = 'require-plain-object'
export const DEFAULT_OBJECT_LITERAL_MODE: ObjectLiteralMode = 'filter-blocked'
