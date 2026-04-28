import { defaultCallPermissionPolicy } from '../call-permission.js'
import type { JSExprNode } from '../node-types.js'
import { enterCall, leaveCall, consumeStep } from './state.js'
import {
  JSEvalError,
  PURE_EXPR_ARROW_BRAND,
  type EvalState,
  type JSCallKind,
  type JSCallable,
} from './types.js'

export function appendIterableValues(
  target: unknown[],
  source: unknown,
  node: JSExprNode,
  state: EvalState,
): void {
  for (const value of source as Iterable<unknown>) {
    consumeStep(state, node)
    target.push(value)
  }
}

export function isPureExprArrowFunction(value: unknown): value is JSCallable {
  return (
    typeof value === 'function' &&
    (value as Record<PropertyKey, unknown>)[PURE_EXPR_ARROW_BRAND] === true
  )
}

export function ensureCallAllowed(
  kind: JSCallKind,
  fn: JSCallable,
  thisValue: unknown,
  node: JSExprNode,
  state: EvalState,
): void {
  if (state.opts.allowCalls === false) {
    throw new JSEvalError('Function calls are not enabled', node)
  }

  const policy = state.opts.isCallableAllowed ?? defaultCallPermissionPolicy
  if (policy === defaultCallPermissionPolicy && isPureExprArrowFunction(fn)) return
  if (!policy({ kind, fn, thisValue, node })) {
    throw new JSEvalError('Calling this function is not permitted', node)
  }
}

export function safeCall0(
  fn: JSCallable,
  thisVal: unknown,
  node: JSExprNode,
  state: EvalState,
): unknown {
  enterCall(node, state)
  try {
    return Reflect.apply(fn, thisVal, [])
  } finally {
    leaveCall(state)
  }
}

export function safeCall1(
  fn: JSCallable,
  thisVal: unknown,
  arg0: unknown,
  node: JSExprNode,
  state: EvalState,
): unknown {
  enterCall(node, state)
  try {
    return Reflect.apply(fn, thisVal, [arg0])
  } finally {
    leaveCall(state)
  }
}

export function safeCall2(
  fn: JSCallable,
  thisVal: unknown,
  arg0: unknown,
  arg1: unknown,
  node: JSExprNode,
  state: EvalState,
): unknown {
  enterCall(node, state)
  try {
    return Reflect.apply(fn, thisVal, [arg0, arg1])
  } finally {
    leaveCall(state)
  }
}

export function safeCall3(
  fn: JSCallable,
  thisVal: unknown,
  arg0: unknown,
  arg1: unknown,
  arg2: unknown,
  node: JSExprNode,
  state: EvalState,
): unknown {
  enterCall(node, state)
  try {
    return Reflect.apply(fn, thisVal, [arg0, arg1, arg2])
  } finally {
    leaveCall(state)
  }
}

export function safeCall4(
  fn: JSCallable,
  thisVal: unknown,
  arg0: unknown,
  arg1: unknown,
  arg2: unknown,
  arg3: unknown,
  node: JSExprNode,
  state: EvalState,
): unknown {
  enterCall(node, state)
  try {
    return Reflect.apply(fn, thisVal, [arg0, arg1, arg2, arg3])
  } finally {
    leaveCall(state)
  }
}

export function safeCall(
  fn: JSCallable,
  thisVal: unknown,
  args: unknown[],
  node: JSExprNode,
  state: EvalState,
): unknown {
  enterCall(node, state)
  try {
    switch (args.length) {
      case 0:
        return Reflect.apply(fn, thisVal, [])
      case 1:
        return Reflect.apply(fn, thisVal, [args[0]])
      case 2:
        return Reflect.apply(fn, thisVal, [args[0], args[1]])
      case 3:
        return Reflect.apply(fn, thisVal, [args[0], args[1], args[2]])
      case 4:
        return Reflect.apply(fn, thisVal, [args[0], args[1], args[2], args[3]])
      default:
        return Reflect.apply(fn, thisVal, args)
    }
  } finally {
    leaveCall(state)
  }
}
