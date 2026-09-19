import type { AstNode, ExpressionNode } from '../node-types.js'
import { createLocalScope, createRootScope } from './context.js'
import {
  type DirectEvalState,
  type DirectLocalEvalState,
  type EvalState,
  type EvaluationScope,
  type ExecutionBudget,
  JSEvalError,
  type JSEvalOptions,
  type ScopedEvalState,
} from './types.js'

export function createScopedEvalState(
  scope: EvaluationScope,
  opts: Readonly<JSEvalOptions>,
  sharedBudget?: ExecutionBudget,
): ScopedEvalState {
  const state: ScopedEvalState = {
    kind: 'scoped',
    scope,
    callDepth: 0,
    steps: 0,
    topics: [],
    opts,
  }
  if (sharedBudget) state.budget = sharedBudget
  return state
}

export function createDirectEvalState(
  context: Readonly<Record<string, unknown>>,
  opts: Readonly<JSEvalOptions>,
  sharedBudget?: ExecutionBudget,
): DirectEvalState {
  const state: DirectEvalState = {
    kind: 'direct',
    context,
    callDepth: 0,
    steps: 0,
    topics: [],
    opts,
  }
  if (sharedBudget) state.budget = sharedBudget
  return state
}

export function createDirectLocalEvalState(
  locals: Record<string, unknown>,
  environment: EvaluationScope['environment'],
  opts: Readonly<JSEvalOptions>,
  sharedBudget: ExecutionBudget,
): DirectLocalEvalState {
  if (!environment.directContext) {
    throw new JSEvalError('Direct local evaluation requires a direct root context')
  }
  return {
    kind: 'direct-local',
    locals,
    rootContext: environment.directContext,
    environment,
    budget: sharedBudget,
    callDepth: 0,
    steps: 0,
    topics: [],
    opts,
  }
}

export function ensureEvalScope(state: EvalState): EvaluationScope {
  if (state.kind === 'scoped') return state.scope
  if (state.materializedScope) return state.materializedScope
  if (state.kind === 'direct-local') {
    const scope = createLocalScope(state.environment, state.locals)
    state.materializedScope = scope
    return scope
  }
  const environment = {
    data: [state.context],
    capabilities: [],
    directContext: state.context,
    writes: 'deny' as const,
  }
  const scope = createRootScope(environment)
  state.materializedScope = scope
  return scope
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
