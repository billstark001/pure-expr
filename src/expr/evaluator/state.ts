import type { AstNode, ExpressionNode } from '../node-types.js'
import { type EvalState, type ExecutionBudget, JSEvalError, type JSEvalOptions } from './types.js'

export function createEvalState(
  context: Readonly<Record<string, unknown>>,
  opts: Readonly<JSEvalOptions>,
  sharedBudget?: ExecutionBudget,
): EvalState {
  const state = {
    context,
    callDepth: 0,
    steps: 0,
    topics: [],
    opts,
  } as unknown as EvalState
  state.budget = sharedBudget ?? state
  return state
}

export function consumeStep(state: EvalState, node: AstNode, amount = 1): void {
  const max = state.opts.maxSteps
  if (max === undefined) return

  state.budget.steps += amount
  if (state.budget.steps > max) {
    throw new JSEvalError(`Maximum evaluation steps (${max}) exceeded`, node)
  }
}

export function enterCall(node: ExpressionNode, state: EvalState): void {
  const max = state.opts.maxCallDepth ?? 32
  if (state.budget.callDepth >= max) {
    throw new JSEvalError(`Maximum call depth (${max}) exceeded`, node)
  }
  state.budget.callDepth += 1
}

export function leaveCall(state: EvalState): void {
  state.budget.callDepth -= 1
}
