import { defaultCallPermissionPolicy } from '../call-permission.js'
import type { ExpressionNode } from '../node-types.js'
import { createCompileRuntime } from './compile.js'
import {
  completeEvaluation,
  createRootScope,
  createRuntimeEnvironment,
  isEvaluationEnvironment,
  prepareReferenceContext,
} from './context.js'
import { evalArrowFunction, evalNode } from './evaluator.js'
import { resolveDirectIdentifier } from './operations.js'
import { createDirectEvalState, createScopedEvalState } from './state.js'
import {
  type ContextInputMode,
  DEFAULT_CONTEXT_POLICY,
  DEFAULT_CONTEXT_WRITE_MODE,
  DEFAULT_OBJECT_LITERAL_MODE,
  EMPTY_CONTEXT,
  EMPTY_OPTS,
  type EvaluationEnvironment,
  type EvaluationInput,
  type JSEvalOptions,
} from './types.js'

const { compileNode } = createCompileRuntime({ evalArrowFunction })

export class JSEvaluator {
  private readonly context: EvaluationInput
  private directEnvironmentCache?: WeakMap<EvaluationEnvironment, Readonly<Record<string, unknown>>>
  private readonly directInputMode: ContextInputMode
  private readonly useDirectContext: boolean
  private readonly resolvedOpts: Readonly<JSEvalOptions>

  constructor(context: EvaluationInput = EMPTY_CONTEXT, opts: JSEvalOptions = EMPTY_OPTS) {
    this.resolvedOpts = {
      ...opts,
      functionMode: opts.functionMode ?? 'default',
      contextPolicy: opts.contextPolicy
        ? Object.freeze({ ...opts.contextPolicy })
        : DEFAULT_CONTEXT_POLICY,
      writes: opts.writes ?? DEFAULT_CONTEXT_WRITE_MODE,
      objectLiteralMode: opts.objectLiteralMode ?? DEFAULT_OBJECT_LITERAL_MODE,
      isCallableAllowed: opts.isCallableAllowed ?? defaultCallPermissionPolicy,
    }
    this.context = context
    const policy = this.resolvedOpts.contextPolicy!
    this.directInputMode = policy.input ?? 'plain-only'
    this.useDirectContext =
      (policy.isolation ?? 'reference') === 'reference' &&
      (policy.freeze ?? 'none') === 'none' &&
      this.resolvedOpts.writes === 'deny'
  }

  evaluate(node: ExpressionNode, context: EvaluationInput = EMPTY_CONTEXT): unknown {
    const directContext = this.createDirectContext(context)
    if (directContext) {
      return evalNode(node, createDirectEvalState(directContext, this.resolvedOpts))
    }
    const environment = this.createEnvironment(context)
    return completeEvaluation(
      evalNode(node, createScopedEvalState(createRootScope(environment), this.resolvedOpts)),
      environment,
    )
  }

  compile(node: ExpressionNode): (context?: EvaluationInput) => unknown {
    const trackSteps = this.resolvedOpts.maxSteps !== undefined
    const directExecute = this.useDirectContext
      ? createCompileRuntime({
          evalArrowFunction,
          resolveIdentifier: resolveDirectIdentifier,
          trackSteps,
        }).compileNode(node)
      : undefined
    const compileGeneral = () =>
      trackSteps
        ? compileNode(node)
        : createCompileRuntime({ evalArrowFunction, trackSteps: false }).compileNode(node)
    let execute = directExecute ? undefined : compileGeneral()
    return (context = EMPTY_CONTEXT) => {
      const directContext = this.createDirectContext(context)
      if (directContext) {
        return directExecute!(createDirectEvalState(directContext, this.resolvedOpts))
      }
      const environment = this.createEnvironment(context)
      execute ??= compileGeneral()
      return completeEvaluation(
        execute(createScopedEvalState(createRootScope(environment), this.resolvedOpts)),
        environment,
      )
    }
  }

  private createDirectContext(
    context: EvaluationInput,
  ): Readonly<Record<string, unknown>> | undefined {
    if (!this.useDirectContext) return undefined
    const input =
      context === EMPTY_CONTEXT
        ? this.context
        : this.context === EMPTY_CONTEXT
          ? context
          : undefined
    if (!input) return undefined
    if (this.directInputMode === 'plain-only') {
      const prototype = Object.getPrototypeOf(input)
      if (prototype === Object.prototype || prototype === null) {
        return input as Readonly<Record<string, unknown>>
      }
      if (isEvaluationEnvironment(input)) return this.createDirectEnvironmentContext(input)
    } else if (isEvaluationEnvironment(input)) {
      return this.createDirectEnvironmentContext(input)
    }
    return prepareReferenceContext(input, this.directInputMode, 'Evaluation context')
  }

  private createDirectEnvironmentContext(
    environment: EvaluationEnvironment,
  ): Readonly<Record<string, unknown>> | undefined {
    const cached = this.directEnvironmentCache?.get(environment)
    if (cached) return cached
    if (environment.variables) return undefined
    const hasData = environment.data !== undefined
    const hasCapabilities = environment.capabilities !== undefined
    if (hasData === hasCapabilities) return undefined

    const value = hasData ? environment.data! : environment.capabilities!
    const policy = hasData
      ? (environment.dataPolicy ?? this.resolvedOpts.contextPolicy!)
      : (environment.capabilitiesPolicy ?? {
          input: 'allow' as const,
          isolation: 'reference' as const,
          freeze: 'none' as const,
        })
    if ((policy.isolation ?? 'reference') !== 'reference' || (policy.freeze ?? 'none') !== 'none') {
      return undefined
    }
    const prepared = prepareReferenceContext(
      value,
      policy.input ?? (hasData ? this.directInputMode : 'allow'),
      'Evaluation context',
    )
    if (!this.directEnvironmentCache) this.directEnvironmentCache = new WeakMap()
    this.directEnvironmentCache.set(environment, prepared)
    return prepared
  }

  private createEnvironment(context: EvaluationInput) {
    const inputs = context === EMPTY_CONTEXT ? [this.context] : [this.context, context]
    return createRuntimeEnvironment(inputs, this.resolvedOpts)
  }
}
