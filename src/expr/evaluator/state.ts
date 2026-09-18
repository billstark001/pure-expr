import type { AstNode, ExpressionNode } from '../node-types.js'
import { createLocalScope, createRootScope, createRuntimeEnvironment } from './context.js'
import {
  EVALUATION_SCOPE_BRAND,
  type EvalState,
  type EvaluationInput,
  type EvaluationScope,
  type ExecutionBudget,
  JSEvalError,
  type JSEvalOptions,
} from './types.js'

export function createEvalState(
  input: EvaluationScope | EvaluationInput,
  opts: Readonly<JSEvalOptions>,
  sharedBudget?: ExecutionBudget,
): EvalState {
  const scope = isEvaluationScope(input)
    ? input
    : createRootScope(createRuntimeEnvironment([input], opts))
  const state: EvalState = {
    scope,
    callDepth: 0,
    steps: 0,
    topics: [],
    opts,
  }
  if (!scope.parent && scope.environment.directContext) {
    state.directLocals = scope.locals
    state.directRootContext = scope.environment.directContext
  }
  if (sharedBudget) state.budget = sharedBudget
  return state
}

export function createDirectEvalState(
  context: Readonly<Record<string, unknown>>,
  opts: Readonly<JSEvalOptions>,
  sharedBudget?: ExecutionBudget,
): EvalState {
  const state: EvalState = {
    directContext: context,
    callDepth: 0,
    steps: 0,
    topics: [],
    opts,
  }
  if (sharedBudget) state.budget = sharedBudget
  return state
}

export function createScopedEvalState(
  scope: EvaluationScope,
  opts: Readonly<JSEvalOptions>,
  sharedBudget?: ExecutionBudget,
): EvalState {
  const state: EvalState = {
    scope,
    callDepth: 0,
    steps: 0,
    topics: [],
    opts,
  }
  if (!scope.parent && scope.environment.directContext) {
    state.directLocals = scope.locals
    state.directRootContext = scope.environment.directContext
  }
  if (sharedBudget) state.budget = sharedBudget
  return state
}

export function createDirectLocalEvalState(
  locals: Record<string, unknown>,
  environment: EvaluationScope['environment'],
  opts: Readonly<JSEvalOptions>,
  sharedBudget: ExecutionBudget,
): EvalState {
  return {
    directLocals: locals,
    directRootContext: environment.directContext,
    deferredEnvironment: environment,
    budget: sharedBudget,
    callDepth: 0,
    steps: 0,
    topics: [],
    opts,
  }
}

export function ensureEvalScope(state: EvalState): EvaluationScope {
  if (state.scope) return state.scope
  if (state.directLocals) {
    const scope = createLocalScope(state.deferredEnvironment!, state.directLocals)
    state.scope = scope
    return scope
  }
  const environment = {
    data: [state.directContext!],
    capabilities: [],
    directContext: state.directContext!,
    writes: 'deny' as const,
  }
  const scope = createRootScope(environment)
  state.scope = scope
  return scope
}

function isEvaluationScope(input: EvaluationScope | EvaluationInput): input is EvaluationScope {
  return (
    ((typeof input === 'object' && input !== null) || typeof input === 'function') &&
    (input as Partial<EvaluationScope>)[EVALUATION_SCOPE_BRAND] === true
  )
}

export function consumeStep(state: EvalState, node: AstNode, amount = 1): void {
  const max = state.opts.maxSteps
  if (max === undefined) return

  const budget = state.budget ?? state
  budget.steps += amount
  if (budget.steps > max) {
    throw new JSEvalError(`Maximum evaluation steps (${max}) exceeded`, node)
  }
}

export function enterCall(node: ExpressionNode, state: EvalState): void {
  const max = state.opts.maxCallDepth ?? 32
  const budget = state.budget ?? state
  if (budget.callDepth >= max) {
    throw new JSEvalError(`Maximum call depth (${max}) exceeded`, node)
  }
  budget.callDepth += 1
}

export function leaveCall(state: EvalState): void {
  const budget = state.budget ?? state
  budget.callDepth -= 1
}
