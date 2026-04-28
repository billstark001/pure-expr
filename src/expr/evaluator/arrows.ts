import type { JSArrowParameterNode, JSBindingNode, JSExprNode } from '../node-types.js'
import { createObjectLiteralResult, getObjectLiteralMode } from './context.js'
import { consumeStep } from './state.js'
import {
  JSEvalError,
  PURE_EXPR_ARROW_BRAND,
  type CompiledArrowBinding,
  type CompiledArrowParameterEvaluator,
  type CompiledNodeEvaluator,
  type EvalState,
  type JSCallable,
} from './types.js'
import { BLOCKED_PROPS } from './security.js'

export function createPureExprArrowFunction(
  invoke: (...args: unknown[]) => unknown,
  expectedArgumentCount: number,
): JSCallable {
  const fn = (...args: unknown[]) => invoke(...args)

  Object.defineProperty(fn, PURE_EXPR_ARROW_BRAND, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  })

  try {
    Object.defineProperty(fn, 'length', {
      value: expectedArgumentCount,
      enumerable: false,
      writable: false,
      configurable: true,
    })
  } catch {
    // Ignore runtimes that expose non-configurable function length descriptors.
  }

  return fn as JSCallable
}

export function getArrowExpectedArgumentCount(params: JSArrowParameterNode[]): number {
  let count = 0

  for (const param of params) {
    if (param.rest || bindingHasInitializer(param.binding)) return count
    count += 1
  }

  return count
}

function bindingHasInitializer(binding: JSBindingNode): boolean {
  switch (binding.type) {
    case 'binding-identifier':
      return false
    case 'binding-assignment':
      return true
    case 'binding-array':
      return binding.elements.some((element) => element !== null && bindingHasInitializer(element))
    case 'binding-object':
      return binding.properties.some((prop) => bindingHasInitializer(prop.value))
  }
}

export function collectArrowBoundNames(params: JSArrowParameterNode[]): string[] {
  const names: string[] = []
  for (const param of params) collectBindingNames(param.binding, names)
  return names
}

function collectBindingNames(binding: JSBindingNode, names: string[]): void {
  switch (binding.type) {
    case 'binding-identifier':
      names.push(binding.name)
      return
    case 'binding-assignment':
      collectBindingNames(binding.left, names)
      return
    case 'binding-array':
      for (const element of binding.elements) {
        if (element) collectBindingNames(element, names)
      }
      if (binding.rest) collectBindingNames(binding.rest, names)
      return
    case 'binding-object':
      for (const prop of binding.properties) collectBindingNames(prop.value, names)
      if (binding.rest) names.push(binding.rest.name)
      return
  }
}

export function bindCompiledArrowParameters(
  params: CompiledArrowParameterEvaluator[],
  args: unknown[],
  state: EvalState,
): void {
  let argIndex = 0

  for (const param of params) {
    const value = param.rest ? args.slice(argIndex) : args[argIndex]
    if (!param.rest) argIndex += 1
    else argIndex = args.length
    param.bind(value, state)
  }
}

export function compileArrowBinding(
  binding: JSBindingNode,
  compileNode: (node: JSExprNode) => CompiledNodeEvaluator,
): CompiledArrowBinding {
  switch (binding.type) {
    case 'binding-identifier':
      return (value, state) => {
        ;(state.context as Record<string, unknown>)[binding.name] = value
      }

    case 'binding-assignment': {
      const left = compileArrowBinding(binding.left, compileNode)
      const defaultValue = compileNode(binding.defaultValue)
      return (value, state) => {
        left(value === undefined ? defaultValue(state) : value, state)
      }
    }

    case 'binding-array': {
      const elements = binding.elements.map((element) =>
        element === null ? null : compileArrowBinding(element, compileNode),
      )
      const rest = binding.rest ? compileArrowBinding(binding.rest, compileNode) : null
      return (value, state) => {
        if (
          value == null ||
          typeof (value as Record<PropertyKey, unknown>)[Symbol.iterator] !== 'function'
        ) {
          throw new JSEvalError('Array binding patterns require an iterable value')
        }

        const values = Array.from(value as Iterable<unknown>)
        let index = 0
        for (const element of elements) {
          if (element) element(values[index], state)
          index += 1
        }
        if (rest) rest(values.slice(index), state)
      }
    }

    case 'binding-object': {
      const properties = binding.properties.map((prop) => ({
        key: compileKeyResolver(prop.key, prop.computed, compileNode),
        bind: compileArrowBinding(prop.value, compileNode),
      }))
      const restName = binding.rest?.name
      const restStepNode = binding.rest ? keyNodeForStepBudget(binding.rest) : undefined

      return (value, state) => {
        if (value == null) {
          throw new JSEvalError('Object binding patterns cannot destructure null or undefined')
        }

        const source = Object(value) as Record<string, unknown>
        const excluded = restName ? new Set<string>() : undefined

        for (const prop of properties) {
          const key = prop.key(state)
          excluded?.add(key)
          prop.bind(source[key], state)
        }

        if (restName) {
          const restValue = createObjectLiteralResult(getObjectLiteralMode(state.opts))
          for (const key of Object.keys(source)) {
            consumeStep(state, restStepNode!)
            if (excluded!.has(key) || BLOCKED_PROPS.has(key)) continue
            restValue[key] = source[key]
          }
          ;(state.context as Record<string, unknown>)[restName] = restValue
        }
      }
    }
  }
}

function compileKeyResolver(
  keyNode: JSExprNode,
  computed: boolean,
  compileNode: (node: JSExprNode) => CompiledNodeEvaluator,
): (state: EvalState) => string {
  if (!computed && keyNode.type === 'identifier') {
    const key = keyNode.name
    return () => key
  }
  if (!computed && keyNode.type === 'literal') {
    const key = String(keyNode.value)
    return () => key
  }

  const execute = compileNode(keyNode)
  return (state) => String(execute(state))
}

export function bindArrowParameters(
  params: JSArrowParameterNode[],
  args: unknown[],
  state: EvalState,
  evalNode: (node: JSExprNode, state: EvalState) => unknown,
): void {
  let argIndex = 0

  for (const param of params) {
    const value = param.rest ? args.slice(argIndex) : args[argIndex]
    if (!param.rest) argIndex += 1
    else argIndex = args.length
    bindArrowBinding(param.binding, value, state, evalNode)
  }
}

export function bindArrowBinding(
  binding: JSBindingNode,
  value: unknown,
  state: EvalState,
  evalNode: (node: JSExprNode, state: EvalState) => unknown,
): void {
  switch (binding.type) {
    case 'binding-identifier':
      ;(state.context as Record<string, unknown>)[binding.name] = value
      return

    case 'binding-assignment':
      bindArrowBinding(
        binding.left,
        value === undefined ? evalNode(binding.defaultValue, state) : value,
        state,
        evalNode,
      )
      return

    case 'binding-array': {
      if (
        value == null ||
        typeof (value as Record<PropertyKey, unknown>)[Symbol.iterator] !== 'function'
      ) {
        throw new JSEvalError('Array binding patterns require an iterable value')
      }

      const values = Array.from(value as Iterable<unknown>)
      let index = 0
      for (const element of binding.elements) {
        if (element) bindArrowBinding(element, values[index], state, evalNode)
        index += 1
      }
      if (binding.rest) bindArrowBinding(binding.rest, values.slice(index), state, evalNode)
      return
    }

    case 'binding-object': {
      if (value == null) {
        throw new JSEvalError('Object binding patterns cannot destructure null or undefined')
      }

      const source = Object(value) as Record<string, unknown>
      const excluded = new Set<string>()

      for (const prop of binding.properties) {
        const key = getBindingPropertyKey(prop.key, prop.computed, state, evalNode)
        excluded.add(key)
        bindArrowBinding(prop.value, source[key], state, evalNode)
      }

      if (binding.rest) {
        const restValue = createObjectLiteralResult(getObjectLiteralMode(state.opts))
        for (const key of Object.keys(source)) {
          consumeStep(state, keyNodeForStepBudget(binding.rest))
          if (excluded.has(key) || BLOCKED_PROPS.has(key)) continue
          restValue[key] = source[key]
        }
        ;(state.context as Record<string, unknown>)[binding.rest.name] = restValue
      }
      return
    }
  }
}

function getBindingPropertyKey(
  keyNode: JSExprNode,
  computed: boolean,
  state: EvalState,
  evalNode: (node: JSExprNode, state: EvalState) => unknown,
): string {
  if (computed) return String(evalNode(keyNode, state))
  if (keyNode.type === 'identifier') return keyNode.name
  if (keyNode.type === 'literal') return String(keyNode.value)
  return String(evalNode(keyNode, state))
}

function keyNodeForStepBudget(binding: JSBindingNode): JSExprNode {
  return {
    type: 'literal',
    value: undefined,
    raw: 'undefined',
    start: binding.start,
    end: binding.end,
  }
}
