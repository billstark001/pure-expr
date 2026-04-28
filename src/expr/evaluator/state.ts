import type { JSExprNode } from '../node-types.js'
import { JSEvalError, type EvalState, type JSEvalOptions } from './types.js'

export function createEvalState(
  context: Readonly<Record<string, unknown>>,
  opts: Readonly<JSEvalOptions>,
): EvalState {
  return { context, callDepth: 0, steps: 0, topics: [], opts }
}

export function consumeStep(state: EvalState, node: JSExprNode, amount = 1): void {
  const max = state.opts.maxSteps
  if (max === undefined) return

  state.steps += amount
  if (state.steps > max) {
    throw new JSEvalError(`Maximum evaluation steps (${max}) exceeded`, node)
  }
}

export function enterCall(node: JSExprNode, state: EvalState): void {
  const max = state.opts.maxCallDepth ?? 32
  if (state.callDepth >= max) throw new JSEvalError(`Maximum call depth (${max}) exceeded`, node)
  state.callDepth += 1
}

export function leaveCall(state: EvalState): void {
  state.callDepth -= 1
}
