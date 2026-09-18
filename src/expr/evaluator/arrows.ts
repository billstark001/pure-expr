import type {
  ArrowFunctionExpression,
  BindingPattern,
  ExpressionNode,
  Identifier,
} from '../node-types.js'
import { createObjectLiteralResult, getObjectLiteralMode } from './context.js'
import { readProperty } from './operations.js'
import { BLOCKED_PROPS } from './security.js'
import { consumeStep } from './state.js'
import {
  type CompiledArrowBinding,
  type CompiledArrowParameterEvaluator,
  type CompiledNodeEvaluator,
  type EvalState,
  type JSCallable,
  JSEvalError,
  PURE_EXPR_ARROW_BRAND,
} from './types.js'

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

export function getArrowExpectedArgumentCount(params: BindingPattern[]): number {
  let count = 0
  for (const param of params) {
    if (param.type === 'RestElement' || param.type === 'AssignmentPattern') return count
    count += 1
  }
  return count
}

export function collectArrowBoundNames(params: BindingPattern[]): string[] {
  const names: string[] = []
  for (const param of params) collectBindingNames(param, names)
  return names
}

function collectBindingNames(binding: BindingPattern, names: string[]): void {
  switch (binding.type) {
    case 'Identifier':
      names.push(binding.name)
      return
    case 'AssignmentPattern':
      collectBindingNames(binding.left, names)
      return
    case 'RestElement':
      collectBindingNames(binding.argument, names)
      return
    case 'ArrayPattern':
      for (const element of binding.elements) {
        if (element) collectBindingNames(element, names)
      }
      return
    case 'ObjectPattern':
      for (const property of binding.properties) {
        collectBindingNames(
          property.type === 'RestElement' ? property.argument : property.value,
          names,
        )
      }
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
  binding: BindingPattern,
  compileNode: (node: ExpressionNode) => CompiledNodeEvaluator,
): CompiledArrowBinding {
  switch (binding.type) {
    case 'Identifier':
      return (value, state) => {
        ;(state.context as Record<string, unknown>)[binding.name] = value
      }

    case 'AssignmentPattern': {
      const left = compileArrowBinding(binding.left, compileNode)
      const right = compileNode(binding.right)
      return (value, state) => left(value === undefined ? right(state) : value, state)
    }

    case 'RestElement':
      return compileArrowBinding(binding.argument, compileNode)

    case 'ArrayPattern': {
      const elements = binding.elements.map((element) =>
        element === null ? null : compileArrowBinding(element, compileNode),
      )
      return (value, state) => {
        const values = iterableBindingValues(value)
        let index = 0
        for (let elementIndex = 0; elementIndex < binding.elements.length; elementIndex += 1) {
          const bindingElement = binding.elements[elementIndex]
          const bind = elements[elementIndex]
          if (bindingElement?.type === 'RestElement') {
            bind!(values.slice(index), state)
            return
          }
          if (bind) bind(values[index], state)
          index += 1
        }
      }
    }

    case 'ObjectPattern': {
      const properties = binding.properties
        .filter((property) => property.type === 'Property')
        .map((property) => ({
          node: property,
          key: compileKeyResolver(property.key, property.computed, compileNode),
          bind: compileArrowBinding(property.value, compileNode),
        }))
      const rest = binding.properties.find((property) => property.type === 'RestElement')
      const restName = rest ? getRestIdentifier(rest.argument).name : undefined

      return (value, state) => {
        if (value == null) {
          throw new JSEvalError('Object binding patterns cannot destructure null or undefined')
        }

        const source = Object(value) as Record<string, unknown>
        const excluded = restName ? new Set<string>() : undefined

        for (const property of properties) {
          const key = property.key(state)
          excluded?.add(key)
          property.bind(readProperty(source, key, property.node, state), state)
        }

        if (restName) {
          const restValue = createObjectLiteralResult(getObjectLiteralMode(state.opts))
          for (const key of Object.keys(source)) {
            consumeStep(state, rest!.argument)
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
  keyNode: ExpressionNode,
  computed: boolean,
  compileNode: (node: ExpressionNode) => CompiledNodeEvaluator,
): (state: EvalState) => string {
  if (!computed && keyNode.type === 'Identifier') {
    const key = keyNode.name
    return () => key
  }
  if (!computed && keyNode.type === 'Literal') {
    const key = String(keyNode.value)
    return () => key
  }

  const execute = compileNode(keyNode)
  return (state) => String(execute(state))
}

export function bindArrowParameters(
  params: BindingPattern[],
  args: unknown[],
  state: EvalState,
  evalNode: (node: ExpressionNode, state: EvalState) => unknown,
): void {
  let argIndex = 0

  for (const param of params) {
    const rest = param.type === 'RestElement'
    const value = rest ? args.slice(argIndex) : args[argIndex]
    if (!rest) argIndex += 1
    else argIndex = args.length
    bindArrowBinding(param, value, state, evalNode)
  }
}

export function bindArrowBinding(
  binding: BindingPattern,
  value: unknown,
  state: EvalState,
  evalNode: (node: ExpressionNode, state: EvalState) => unknown,
): void {
  switch (binding.type) {
    case 'Identifier':
      ;(state.context as Record<string, unknown>)[binding.name] = value
      return

    case 'AssignmentPattern':
      bindArrowBinding(
        binding.left,
        value === undefined ? evalNode(binding.right, state) : value,
        state,
        evalNode,
      )
      return

    case 'RestElement':
      bindArrowBinding(binding.argument, value, state, evalNode)
      return

    case 'ArrayPattern': {
      const values = iterableBindingValues(value)
      let index = 0
      for (const element of binding.elements) {
        if (element?.type === 'RestElement') {
          bindArrowBinding(element.argument, values.slice(index), state, evalNode)
          return
        }
        if (element) bindArrowBinding(element, values[index], state, evalNode)
        index += 1
      }
      return
    }

    case 'ObjectPattern': {
      if (value == null) {
        throw new JSEvalError('Object binding patterns cannot destructure null or undefined')
      }

      const source = Object(value) as Record<string, unknown>
      const rest = binding.properties.find((property) => property.type === 'RestElement')
      const excluded = rest ? new Set<string>() : undefined

      for (const property of binding.properties) {
        if (property.type === 'RestElement') continue
        const key = getBindingKey(property.key, property.computed, state, evalNode)
        excluded?.add(key)
        bindArrowBinding(
          property.value,
          readProperty(source, key, property, state),
          state,
          evalNode,
        )
      }

      if (rest) {
        const restName = getRestIdentifier(rest.argument).name
        const restValue = createObjectLiteralResult(getObjectLiteralMode(state.opts))
        for (const key of Object.keys(source)) {
          consumeStep(state, rest.argument)
          if (excluded!.has(key) || BLOCKED_PROPS.has(key)) continue
          restValue[key] = source[key]
        }
        ;(state.context as Record<string, unknown>)[restName] = restValue
      }
      return
    }
  }
}

function iterableBindingValues(value: unknown): unknown[] {
  if (
    value == null ||
    typeof (value as Record<PropertyKey, unknown>)[Symbol.iterator] !== 'function'
  ) {
    throw new JSEvalError('Array binding patterns require an iterable value')
  }
  return Array.from(value as Iterable<unknown>)
}

function getBindingKey(
  keyNode: ExpressionNode,
  computed: boolean,
  state: EvalState,
  evalNode: (node: ExpressionNode, state: EvalState) => unknown,
): string {
  if (!computed && keyNode.type === 'Identifier') return keyNode.name
  if (!computed && keyNode.type === 'Literal') return String(keyNode.value)
  return String(evalNode(keyNode, state))
}

function getRestIdentifier(binding: BindingPattern): Identifier {
  if (binding.type !== 'Identifier') {
    throw new JSEvalError('Object rest bindings require an identifier')
  }
  return binding
}

export function isArrowFunctionNode(node: ExpressionNode): node is ArrowFunctionExpression {
  return node.type === 'ArrowFunctionExpression'
}
