import type { AstNode, ExpressionNode } from '../node-types.js'
import { type EvalState, type ExecutionBudget, JSEvalError, type JSEvalOptions } from './types.js'

export function createEvalState(
  context: Readonly<Record<string, unknown>>,
  opts: Readonly<JSEvalOptions>,
  sharedBudget?: ExecutionBudget,
): EvalState {
  const state: EvalState = {
    context,
    callDepth: 0,
    steps: 0,
    topics: [],
    opts,
  }
  if (sharedBudget) state.budget = sharedBudget
  return state
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
