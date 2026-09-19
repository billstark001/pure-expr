import type { AstNode, ExpressionNode } from '../node-types.js'

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
export type ContextInputMode = 'plain-only' | 'own-properties' | 'allow'
export type ContextIsolation = 'reference' | 'shallow-snapshot' | 'deep-snapshot'
export type ContextFreeze = 'none' | 'shallow' | 'deep'
export type ContextWriteMode = 'deny' | 'overlay' | 'commit' | 'transaction'

export type ContextPolicy =
  | {
      input?: ContextInputMode
      isolation?: 'reference'
      freeze?: 'none'
    }
  | {
      input?: ContextInputMode
      isolation: 'shallow-snapshot'
      freeze?: 'none' | 'shallow'
    }
  | {
      input?: ContextInputMode
      isolation: 'deep-snapshot'
      freeze?: ContextFreeze
    }

/** Mutable named bindings used by story engines and other stateful hosts. */
export interface BindingStore {
  has(name: string): boolean
  get(name: string): unknown
  set(name: string, value: unknown): void
  delete?(name: string): boolean
  /** Apply a complete transaction. Implementations must either apply every change or none. */
  applyChanges?(changes: ReadonlyMap<string, unknown>): void
}

export interface EvaluationEnvironmentInit {
  readonly data?: object
  readonly capabilities?: object
  readonly variables?: BindingStore
  readonly dataPolicy?: ContextPolicy
  readonly capabilitiesPolicy?: ContextPolicy
}

export const EVALUATION_ENVIRONMENT_BRAND = Symbol.for('pure-expr.evaluation-environment')

/** Explicit layered evaluation input created with `createEvaluationEnvironment`. */
export interface EvaluationEnvironment extends EvaluationEnvironmentInit {
  readonly [EVALUATION_ENVIRONMENT_BRAND]: true
}

/** Object supplied as an evaluation context; its policy determines which shapes are accepted. */
export type EvaluationInput = object | EvaluationEnvironment

export type EvaluationTransactionStatus = 'pending' | 'committed' | 'rolled-back'

export interface EvaluationTransactionResult<T = unknown> {
  readonly value: T
  readonly changes: ReadonlyMap<string, unknown>
  readonly status: EvaluationTransactionStatus
  commit(): void
  rollback(): void
}
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
  /** Permit object property mutation after parsing has enabled member write targets. */
  allowMemberWrites?: boolean
  allowCalls?: boolean
  functionMode?: FunctionMode
  allowRegexLiterals?: boolean
  maxCallDepth?: number
  maxSteps?: number
  contextPolicy?: ContextPolicy
  writes?: ContextWriteMode
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

interface EvalStateBase extends ExecutionBudget {
  budget?: ExecutionBudget
  topics: unknown[]
  opts: Readonly<JSEvalOptions>
}

export interface ScopedEvalState extends EvalStateBase {
  readonly kind: 'scoped'
  readonly scope: EvaluationScope
}

export interface DirectEvalState extends EvalStateBase {
  readonly kind: 'direct'
  readonly context: Readonly<Record<string, unknown>>
  materializedScope?: EvaluationScope
}

export interface DirectLocalEvalState extends EvalStateBase {
  readonly kind: 'direct-local'
  readonly locals: Record<string, unknown>
  readonly rootContext: Readonly<Record<string, unknown>>
  readonly environment: RuntimeEnvironment
  materializedScope?: EvaluationScope
}

export type EvalState = ScopedEvalState | DirectEvalState | DirectLocalEvalState

export interface RuntimeEnvironment {
  data: ReadonlyArray<Readonly<Record<string, unknown>>>
  capabilities: ReadonlyArray<Readonly<Record<string, unknown>>>
  directContext?: Readonly<Record<string, unknown>>
  variables?: BindingStore
  overlay?: Record<string, unknown>
  writes: ContextWriteMode
  transaction?: TransactionBindingStore
}

export const EVALUATION_SCOPE_BRAND = Symbol('pure-expr.evaluation-scope')

export interface EvaluationScope {
  readonly [EVALUATION_SCOPE_BRAND]: true
  environment: RuntimeEnvironment
  locals: Record<string, unknown>
  hasLocalBindings: boolean
  parent?: EvaluationScope
}

export interface TransactionBindingStore extends BindingStore {
  readonly changes: ReadonlyMap<string, unknown>
  readonly status: EvaluationTransactionStatus
  commit(): void
  rollback(): void
}

export interface ExecutionBudget {
  callDepth: number
  steps: number
}

export const EMPTY_CONTEXT: Readonly<Record<string, unknown>> = Object.freeze({})
export const EMPTY_OPTS: Readonly<JSEvalOptions> = Object.freeze({})
export const UNINITIALIZED_ARROW_PARAM = Symbol('pure-expr.uninitialized-arrow-param')
export const PURE_EXPR_ARROW_BRAND = Symbol('pure-expr.arrow-function')
export const DEFAULT_CONTEXT_POLICY: Readonly<ContextPolicy> = Object.freeze({
  input: 'plain-only',
  isolation: 'reference',
  freeze: 'none',
})
export const DEFAULT_CONTEXT_WRITE_MODE: ContextWriteMode = 'deny'
export const DEFAULT_OBJECT_LITERAL_MODE: ObjectLiteralMode = 'filter-blocked'
