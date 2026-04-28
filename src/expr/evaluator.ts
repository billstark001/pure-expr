import { defaultCallPermissionPolicy } from './call-permission.js'
import type {
  JSArrowFunctionNode,
  JSArrowParameterNode,
  JSBindingNode,
  JSExprNode,
  JSUnaryNode,
  JSBinaryNode,
  JSLogicalNode,
  JSMemberNode,
  JSIdentifierNode,
  JSCallNode,
  JSSpreadNode,
  JSTemplateNode,
} from './node-types.js'

// #region Errors, guards, and public policy types

/** Error raised while evaluating an expression AST. */
export class JSEvalError extends Error {
  constructor(
    message: string,
    public readonly node?: JSExprNode,
  ) {
    super(message)
    this.name = 'JSEvalError'
  }
}

// Properties that could escape the sandbox or mutate the prototype chain
const BLOCKED_PROPS = new Set([
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'constructor',
  'prototype',
])

// Identifiers that must never resolve from context
const BLOCKED_GLOBALS = new Set([
  'eval',
  'Function',
  'globalThis',
  'global',
  'window',
  'self',
  'process',
  'require',
  'module',
  'exports',
  'Buffer',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'document',
  'location',
  'history',
  'navigator',
  'alert',
  'confirm',
  'prompt',
  'open',
  'close',
  'Proxy',
  'Reflect',
])

export type TaggedTemplateArrayMode = 'spec' | 'loose'
export type FunctionMode = 'default' | 'performance'

export type RootContextMode =
  | 'allow'
  | 'copy-non-plain-to-null-prototype'
  | 'require-plain-object'
  | 'copy-plain-data-to-null-prototype'
export type ObjectLiteralMode = 'none' | 'filter-blocked' | 'plain-object-only' | 'safe'
export type JSCallKind = 'call' | 'pipeline' | 'tagged-template'
export type JSCallable = CallableFunction

export interface JSCallPermissionContext {
  kind: JSCallKind
  fn: JSCallable
  thisValue: unknown
  node: JSExprNode
}

export type JSCallPermissionPolicy = (details: Readonly<JSCallPermissionContext>) => boolean

/** Permissive call policy that preserves legacy callable behavior. */
export const allowAllCalls: JSCallPermissionPolicy = () => true

type EmulatedTemplateStringsArray = TemplateStringsArray & {
  raw: readonly string[]
}

type CompiledNodeEvaluator = (state: EvalState) => unknown
type CompiledArrowBinding = (value: unknown, state: EvalState) => void
type CompiledKeyEvaluator = (state: EvalState) => string

interface CompiledArgumentEvaluator {
  node: JSExprNode
  spread: boolean
  execute: CompiledNodeEvaluator
}

interface CompiledObjectPropertyEvaluator {
  spread: boolean
  key?: CompiledKeyEvaluator
  execute: CompiledNodeEvaluator
}

interface CompiledArrowParameterEvaluator {
  rest: boolean
  bind: CompiledArrowBinding
}

interface CompiledArrowRuntime {
  body: CompiledNodeEvaluator
  params: CompiledArrowParameterEvaluator[]
  boundNames: string[]
  expectedArgumentCount: number
}

interface EvalState {
  context: Readonly<Record<string, unknown>>
  callDepth: number
  steps: number
  topics: unknown[]
  opts: Readonly<JSEvalOptions>
}

const EMPTY_CONTEXT: Readonly<Record<string, unknown>> = Object.freeze({})
const EMPTY_OPTS: Readonly<JSEvalOptions> = Object.freeze({})
const UNINITIALIZED_ARROW_PARAM = Symbol('pure-expr.uninitialized-arrow-param')
const PURE_EXPR_ARROW_BRAND = Symbol('pure-expr.arrow-function')
const PERFORMANCE_ARROW_RUNTIME_CACHE = new WeakMap<JSArrowFunctionNode, CompiledArrowRuntime>()

const DEFAULT_ROOT_CONTEXT_MODE: RootContextMode = 'require-plain-object'
const DEFAULT_OBJECT_LITERAL_MODE: ObjectLiteralMode = 'filter-blocked'

// #endregion

// #region Context and object helpers

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function createNullPrototypeRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>
}

function cloneContextRecord(source: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result = Object.getPrototypeOf(source) === null ? createNullPrototypeRecord() : {}
  for (const key of Object.keys(source)) result[key] = source[key]
  return result
}

function isPlainDataContainer(value: object): boolean {
  return Array.isArray(value) || isPlainObjectRecord(value)
}

function copyOwnEnumerableToNullPrototype(source: object): Record<string, unknown> {
  const result = createNullPrototypeRecord()
  const record = source as Record<string, unknown>
  for (const key of Object.keys(record)) result[key] = record[key]
  return result
}

function getOwnKeysForDataCopy(source: object, label: string): PropertyKey[] {
  try {
    return Reflect.ownKeys(source)
  } catch {
    throw new JSEvalError(`${label} could not be inspected safely`)
  }
}

function getOwnDescriptorForDataCopy(
  source: object,
  key: PropertyKey,
  label: string,
): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(source, key)
  } catch {
    throw new JSEvalError(`${label} could not be inspected safely`)
  }
}

function clonePlainDataValue(
  value: unknown,
  label: string,
  cloned: WeakMap<object, unknown>,
  visiting: WeakSet<object>,
): unknown {
  if (!isObjectLike(value)) return value

  const existing = cloned.get(value)
  if (existing !== undefined) {
    if (visiting.has(value)) {
      throw new JSEvalError(`${label} must not contain circular references`)
    }
    return existing
  }

  if (!isPlainDataContainer(value)) {
    throw new JSEvalError(
      `${label} must contain only plain objects, null-prototype objects, arrays, and primitives`,
    )
  }

  const result: unknown[] | Record<string, unknown> = Array.isArray(value)
    ? []
    : createNullPrototypeRecord()
  cloned.set(value, result)
  visiting.add(value)

  for (const key of getOwnKeysForDataCopy(value, label)) {
    if (Array.isArray(result) && key === 'length') continue

    const descriptor = getOwnDescriptorForDataCopy(value, key, label)
    if (!descriptor) continue
    if ('get' in descriptor || 'set' in descriptor) {
      throw new JSEvalError(`${label} must not contain accessor properties`)
    }

    Object.defineProperty(result, key, {
      value: clonePlainDataValue(descriptor.value, label, cloned, visiting),
      enumerable: descriptor.enumerable,
      configurable: true,
      writable: true,
    })
  }

  visiting.delete(value)
  return result
}

function copyPlainDataRootToNullPrototype(
  context: Readonly<Record<string, unknown>>,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!isPlainObjectRecord(context)) {
    throw new JSEvalError(`${label} must be a plain object or null-prototype object`)
  }

  return clonePlainDataValue(context, label, new WeakMap(), new WeakSet()) as Readonly<
    Record<string, unknown>
  >
}

function normalizeContextRoot(
  context: Readonly<Record<string, unknown>>,
  mode: RootContextMode,
  label: string,
): Readonly<Record<string, unknown>> {
  if (mode === 'allow') return context
  if (mode === 'copy-plain-data-to-null-prototype') {
    return copyPlainDataRootToNullPrototype(context, label)
  }
  if (isPlainObjectRecord(context)) return context
  if (!isObjectLike(context)) {
    throw new JSEvalError(`${label} must be a plain object or null-prototype object`)
  }
  if (mode === 'copy-non-plain-to-null-prototype') {
    return copyOwnEnumerableToNullPrototype(context)
  }
  throw new JSEvalError(`${label} must be a plain object or null-prototype object`)
}

function mergeContexts(
  base: Readonly<Record<string, unknown>>,
  override: Readonly<Record<string, unknown>>,
  rootMode: RootContextMode,
): Readonly<Record<string, unknown>> {
  if (rootMode === 'allow') return { ...base, ...override }

  const result = createNullPrototypeRecord()
  for (const key of Object.keys(base)) result[key] = base[key]
  for (const key of Object.keys(override)) result[key] = override[key]
  return result
}

function getRootContextMode(opts: Readonly<JSEvalOptions>): RootContextMode {
  return opts.rootContextMode ?? DEFAULT_ROOT_CONTEXT_MODE
}

function getObjectLiteralMode(opts: Readonly<JSEvalOptions>): ObjectLiteralMode {
  return opts.objectLiteralMode ?? DEFAULT_OBJECT_LITERAL_MODE
}

function createObjectLiteralResult(mode: ObjectLiteralMode): Record<string, unknown> {
  return mode === 'safe' ? createNullPrototypeRecord() : {}
}

function copySpreadProperties(
  target: Record<string, unknown>,
  source: unknown,
  node: JSExprNode,
  state: EvalState,
): void {
  const mode = getObjectLiteralMode(state.opts)

  if (source == null) return

  if (mode === 'none') {
    Object.assign(target, source)
    return
  }

  if (mode === 'plain-object-only' || mode === 'safe') {
    if (!isPlainObjectRecord(source)) {
      throw new JSEvalError(
        'Object spread source must be a plain object or null-prototype object',
        node,
      )
    }
  }

  const boxed = Object(source) as Record<string, unknown>
  for (const key of Object.keys(boxed)) {
    consumeStep(state, node)
    if (BLOCKED_PROPS.has(key)) continue
    target[key] = boxed[key]
  }
}

function consumeStep(state: EvalState, node: JSExprNode, amount = 1): void {
  const max = state.opts.maxSteps
  if (max === undefined) return

  state.steps += amount
  if (state.steps > max) {
    throw new JSEvalError(`Maximum evaluation steps (${max}) exceeded`, node)
  }
}

function appendIterableValues(
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

function ensureCallAllowed(
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

function isPureExprArrowFunction(value: unknown): value is JSCallable {
  return (
    typeof value === 'function' &&
    (value as unknown as Record<PropertyKey, unknown>)[PURE_EXPR_ARROW_BRAND] === true
  )
}

function hasOwnEnumerableKeys(value: Readonly<Record<string, unknown>>): boolean {
  if (!isObjectLike(value)) return false
  return Object.keys(value).length > 0
}

// #endregion

// #region Template object emulation

const SPEC_TEMPLATE_OBJECT_CACHE = new WeakMap<JSTemplateNode, EmulatedTemplateStringsArray>()
const LOOSE_TEMPLATE_OBJECT_CACHE = new WeakMap<JSTemplateNode, EmulatedTemplateStringsArray>()

function createTaggedTemplateObject(
  node: JSTemplateNode,
  mode: TaggedTemplateArrayMode,
): EmulatedTemplateStringsArray {
  const cooked = node.quasis.map((quasi) => (quasi.cooked === null ? undefined : quasi.cooked))
  const raw = node.quasis.map((quasi) => quasi.raw)

  if (mode === 'loose') {
    return Object.assign(cooked, { raw }) as unknown as EmulatedTemplateStringsArray
  }

  const templateObject = cooked.slice() as Array<string | undefined>
  const rawObject = Object.freeze(raw.slice())

  Object.defineProperty(templateObject, 'raw', {
    value: rawObject,
    enumerable: false,
    writable: false,
    configurable: false,
  })

  return Object.freeze(templateObject) as unknown as EmulatedTemplateStringsArray
}

function getTaggedTemplateObject(
  node: JSTemplateNode,
  mode: TaggedTemplateArrayMode,
): EmulatedTemplateStringsArray {
  const cache = mode === 'loose' ? LOOSE_TEMPLATE_OBJECT_CACHE : SPEC_TEMPLATE_OBJECT_CACHE
  const cached = cache.get(node)
  if (cached) return cached

  const created = createTaggedTemplateObject(node, mode)
  cache.set(node, created)
  return created
}

// #endregion

// #region Evaluator options and core execution

/** Runtime evaluation options for JSEvaluator. */
export interface JSEvalOptions {
  allowAwait?: boolean
  allowIn?: boolean
  allowCalls?: boolean
  functionMode?: FunctionMode
  allowRegexLiterals?: boolean
  maxCallDepth?: number
  maxSteps?: number
  rootContextMode?: RootContextMode
  objectLiteralMode?: ObjectLiteralMode
  isCallableAllowed?: JSCallPermissionPolicy
  taggedTemplateArrayMode?: TaggedTemplateArrayMode
}

/** Internal state used during evaluation. */
export function createEvalState(
  context: Readonly<Record<string, unknown>>,
  opts: Readonly<JSEvalOptions>,
): EvalState {
  return { context, callDepth: 0, steps: 0, topics: [], opts }
}

/** Evaluates a JavaScript expression node within a given state. */
export function evalNode(node: JSExprNode, state: EvalState): unknown {
  consumeStep(state, node)

  switch (node.type) {
    case 'literal':
      return node.value

    case 'regex': {
      if (state.opts.allowRegexLiterals === false) {
        throw new JSEvalError('Regular expression literals are not enabled', node)
      }
      return new RegExp(node.pattern, node.flags)
    }

    case 'identifier': {
      if (BLOCKED_GLOBALS.has(node.name))
        throw new JSEvalError(`Access to '${node.name}' is not permitted`, node)
      if (!Object.prototype.hasOwnProperty.call(state.context, node.name))
        throw new JSEvalError(`'${node.name}' is not defined`, node)
      const value = state.context[node.name]
      if (value === UNINITIALIZED_ARROW_PARAM) {
        throw new JSEvalError(`Cannot access '${node.name}' before initialization`, node)
      }
      return value
    }

    case 'topic': {
      if (state.topics.length === 0) {
        throw new JSEvalError("Topic reference '%' is only available inside a pipeline body", node)
      }
      return state.topics[state.topics.length - 1]
    }

    case 'arrow-function':
      return evalArrowFunction(node, state)

    case 'unary':
      return evalUnary(node, state)
    case 'binary':
      return evalBinary(node, state)
    case 'logical':
      return evalLogical(node, state)
    case 'conditional': {
      return evalNode(node.test, state)
        ? evalNode(node.consequent, state)
        : evalNode(node.alternate, state)
    }

    case 'member':
      return evalMember(node, state)
    case 'call':
      return evalCall(node, state)

    case 'array': {
      const result: unknown[] = []
      for (const el of node.elements) {
        consumeStep(state, node)
        if (el === null) result.push(undefined)
        else if (el.type === 'spread')
          appendIterableValues(result, evalNode(el.argument, state), el, state)
        else result.push(evalNode(el, state))
      }
      return result
    }

    case 'object': {
      const result = createObjectLiteralResult(getObjectLiteralMode(state.opts))
      for (const prop of node.props) {
        if (prop.type === 'spread') {
          copySpreadProperties(result, evalNode(prop.argument, state), node, state)
        } else {
          consumeStep(state, node)
          const key = prop.computed
            ? String(evalNode(prop.key, state))
            : prop.key.type === 'identifier'
              ? prop.key.name
              : String(evalNode(prop.key, state))
          if (BLOCKED_PROPS.has(key))
            throw new JSEvalError(`Property '${key}' is not accessible`, node)
          result[key] = evalNode(prop.value, state)
        }
      }
      return result
    }

    case 'template':
      return evalTemplate(node, state)

    case 'spread':
      throw new JSEvalError('Unexpected spread expression outside of array/call/object', node)

    case 'sequence': {
      let last: unknown
      for (const expr of node.expressions) last = evalNode(expr, state)
      return last
    }

    case 'pipeline': {
      const value = evalNode(node.left, state)
      state.topics.push(value)
      try {
        return evalNode(node.right, state)
      } finally {
        state.topics.pop()
      }
    }

    default: {
      const exhaustive: never = node
      throw new JSEvalError(`Unknown node type: ${(exhaustive as any).type}`, node as any)
    }
  }
}

function evalArrowFunction(node: JSArrowFunctionNode, state: EvalState): unknown {
  return state.opts.functionMode === 'performance'
    ? evalArrowFunctionPerformance(node, state)
    : evalArrowFunctionDefault(node, state)
}

function evalArrowFunctionDefault(node: JSArrowFunctionNode, state: EvalState): unknown {
  const capturedContext = state.context
  const capturedTopics = state.topics.slice()
  const capturedOpts = state.opts
  const expectedArgumentCount = getArrowExpectedArgumentCount(node.params)

  return createPureExprArrowFunction((...args: unknown[]) => {
    const localContext = cloneContextRecord(capturedContext)
    for (const name of collectArrowBoundNames(node.params)) {
      localContext[name] = UNINITIALIZED_ARROW_PARAM
    }

    const callState = createEvalState(localContext, capturedOpts)
    callState.topics = capturedTopics.slice()
    bindArrowParameters(node.params, args, callState)
    return evalNode(node.body, callState)
  }, expectedArgumentCount)
}

function evalArrowFunctionPerformance(node: JSArrowFunctionNode, state: EvalState): unknown {
  const runtime = getCompiledArrowRuntime(node)
  const capturedContext = state.context
  const capturedTopics = state.topics.slice()
  const capturedOpts = state.opts

  return createPureExprArrowFunction((...args: unknown[]) => {
    const localContext = cloneContextRecord(capturedContext)
    for (const name of runtime.boundNames) {
      localContext[name] = UNINITIALIZED_ARROW_PARAM
    }

    const callState = createEvalState(localContext, capturedOpts)
    callState.topics = capturedTopics.slice()
    bindCompiledArrowParameters(runtime.params, args, callState)
    return runtime.body(callState)
  }, runtime.expectedArgumentCount)
}

function createPureExprArrowFunction(
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

function getCompiledArrowRuntime(node: JSArrowFunctionNode): CompiledArrowRuntime {
  const cached = PERFORMANCE_ARROW_RUNTIME_CACHE.get(node)
  if (cached) return cached

  const compiled = {
    body: compileNode(node.body),
    params: node.params.map((param) => ({
      rest: param.rest,
      bind: compileArrowBinding(param.binding),
    })),
    boundNames: collectArrowBoundNames(node.params),
    expectedArgumentCount: getArrowExpectedArgumentCount(node.params),
  } satisfies CompiledArrowRuntime

  PERFORMANCE_ARROW_RUNTIME_CACHE.set(node, compiled)
  return compiled
}

function withCompiledStep(node: JSExprNode, execute: CompiledNodeEvaluator): CompiledNodeEvaluator {
  return (state) => {
    consumeStep(state, node)
    return execute(state)
  }
}

function compileNode(node: JSExprNode): CompiledNodeEvaluator {
  switch (node.type) {
    case 'literal':
      return withCompiledStep(node, () => node.value)

    case 'regex':
      return withCompiledStep(node, (state) => {
        if (state.opts.allowRegexLiterals === false) {
          throw new JSEvalError('Regular expression literals are not enabled', node)
        }
        return new RegExp(node.pattern, node.flags)
      })

    case 'identifier':
      return withCompiledStep(node, (state) => {
        if (BLOCKED_GLOBALS.has(node.name)) {
          throw new JSEvalError(`Access to '${node.name}' is not permitted`, node)
        }
        if (!Object.prototype.hasOwnProperty.call(state.context, node.name)) {
          throw new JSEvalError(`'${node.name}' is not defined`, node)
        }
        const value = state.context[node.name]
        if (value === UNINITIALIZED_ARROW_PARAM) {
          throw new JSEvalError(`Cannot access '${node.name}' before initialization`, node)
        }
        return value
      })

    case 'topic':
      return withCompiledStep(node, (state) => {
        if (state.topics.length === 0) {
          throw new JSEvalError(
            "Topic reference '%' is only available inside a pipeline body",
            node,
          )
        }
        return state.topics[state.topics.length - 1]
      })

    case 'arrow-function':
      return withCompiledStep(node, (state) => evalArrowFunction(node, state))

    case 'unary': {
      const operand = compileNode(node.operand)
      return withCompiledStep(node, (state) => {
        if (node.operator === 'typeof') {
          try {
            const value = operand(state)
            return typeof value
          } catch (error) {
            if (error instanceof JSEvalError && node.operand.type === 'identifier')
              return 'undefined'
            throw error
          }
        }

        const value = operand(state)
        switch (node.operator) {
          case '!':
            return !value
          case '~':
            return ~(value as any)
          case '+':
            return +(value as any)
          case '-':
            return -(value as any)
          case 'void':
            return undefined
          case 'await':
            return value
        }
      })
    }

    case 'binary': {
      const left = compileNode(node.left)
      const right = compileNode(node.right)
      return withCompiledStep(node, (state) => {
        const l = left(state)
        const r = right(state)
        switch (node.operator) {
          case '+':
            return (l as any) + (r as any)
          case '-':
            return (l as any) - (r as any)
          case '*':
            return (l as any) * (r as any)
          case '/':
            return (l as any) / (r as any)
          case '%':
            return (l as any) % (r as any)
          case '**':
            return (l as any) ** (r as any)
          case '&':
            return (l as any) & (r as any)
          case '|':
            return (l as any) | (r as any)
          case '^':
            return (l as any) ^ (r as any)
          case '<<':
            return (l as any) << (r as any)
          case '>>':
            return (l as any) >> (r as any)
          case '>>>':
            return (l as any) >>> (r as any)
          case '==':
            // biome-ignore lint/suspicious/noDoubleEquals: The evaluator intentionally preserves JS loose equality semantics.
            return l == r
          case '!=':
            // biome-ignore lint/suspicious/noDoubleEquals: The evaluator intentionally preserves JS loose inequality semantics.
            return l != r
          case '===':
            return l === r
          case '!==':
            return l !== r
          case '<':
            return (l as any) < (r as any)
          case '>':
            return (l as any) > (r as any)
          case '<=':
            return (l as any) <= (r as any)
          case '>=':
            return (l as any) >= (r as any)
          case 'instanceof':
            return (l as any) instanceof (r as any)
          case 'in':
            return (l as any) in (r as any)
          default:
            throw new JSEvalError(`Unknown binary operator '${node.operator}'`, node)
        }
      })
    }

    case 'logical': {
      const left = compileNode(node.left)
      const right = compileNode(node.right)
      return withCompiledStep(node, (state) => {
        const value = left(state)
        switch (node.operator) {
          case '&&':
            return value ? right(state) : value
          case '||':
            return value ? value : right(state)
          case '??':
            return value != null ? value : right(state)
        }
      })
    }

    case 'conditional': {
      const test = compileNode(node.test)
      const consequent = compileNode(node.consequent)
      const alternate = compileNode(node.alternate)
      return withCompiledStep(node, (state) => (test(state) ? consequent(state) : alternate(state)))
    }

    case 'member': {
      const object = compileNode(node.object)
      const property = node.computed ? compileNode(node.property) : undefined
      const identifierKey = !node.computed ? (node.property as JSIdentifierNode).name : undefined

      return withCompiledStep(node, (state) => {
        const target = object(state)
        if (node.optional && target == null) return undefined
        if (target == null) {
          throw new JSEvalError(
            `Cannot read properties of ${target === null ? 'null' : 'undefined'}`,
            node,
          )
        }

        const key = property ? String(property(state)) : identifierKey!
        if (BLOCKED_PROPS.has(key)) {
          throw new JSEvalError(`Access to property '${key}' is not permitted`, node)
        }

        return (target as any)[key]
      })
    }

    case 'call': {
      const args = compileArgumentEvaluators(node.args)

      if (node.callee.type === 'member') {
        const memberNode = node.callee
        const object = compileNode(memberNode.object)
        const property = memberNode.computed ? compileNode(memberNode.property) : undefined
        const identifierKey = !memberNode.computed
          ? (memberNode.property as JSIdentifierNode).name
          : undefined

        return withCompiledStep(node, (state) => {
          const target = object(state)
          if (memberNode.optional && target == null) return undefined
          if (target == null) throw new JSEvalError('Cannot call method on null/undefined', node)

          const key = property ? String(property(state)) : identifierKey!
          if (BLOCKED_PROPS.has(key)) {
            throw new JSEvalError(`Access to method '${key}' is not permitted`, node)
          }

          const fn = (target as any)[key]
          if (node.optional && fn == null) return undefined
          if (typeof fn !== 'function') {
            throw new JSEvalError(
              `'${memberNode.property.type === 'identifier' ? memberNode.property.name : 'value'}' is not a function`,
              node,
            )
          }

          const callable = fn as JSCallable
          ensureCallAllowed('call', callable, target, node, state)
          return invokeCompiledCall(callable, target, args, node, state)
        })
      }

      const callee = compileNode(node.callee)
      const calleeName = node.callee.type === 'identifier' ? node.callee.name : 'value'

      return withCompiledStep(node, (state) => {
        const fn = callee(state)
        if (node.optional && fn == null) return undefined
        if (typeof fn !== 'function') {
          throw new JSEvalError(`'${calleeName}' is not a function`, node)
        }

        const callable = fn as JSCallable
        ensureCallAllowed('call', callable, undefined, node, state)
        return invokeCompiledCall(callable, undefined, args, node, state)
      })
    }

    case 'array': {
      const elements = node.elements.map((element) => (element ? compileNode(element) : null))
      return withCompiledStep(node, (state) => {
        const result: unknown[] = []
        for (let index = 0; index < node.elements.length; index += 1) {
          consumeStep(state, node)
          const element = node.elements[index]
          const execute = elements[index]
          if (element === null || execute === null) {
            result.push(undefined)
          } else if (element.type === 'spread') {
            appendIterableValues(result, execute(state), element, state)
          } else {
            result.push(execute(state))
          }
        }
        return result
      })
    }

    case 'object': {
      const props = node.props.map((prop) =>
        prop.type === 'spread'
          ? ({
              spread: true,
              execute: compileNode(prop.argument),
            } satisfies CompiledObjectPropertyEvaluator)
          : ({
              spread: false,
              key: compileKeyEvaluator(prop.key, prop.computed),
              execute: compileNode(prop.value),
            } satisfies CompiledObjectPropertyEvaluator),
      )

      return withCompiledStep(node, (state) => {
        const result = createObjectLiteralResult(getObjectLiteralMode(state.opts))
        for (const prop of props) {
          if (prop.spread) {
            copySpreadProperties(result, prop.execute(state), node, state)
          } else {
            consumeStep(state, node)
            const key = prop.key!(state)
            if (BLOCKED_PROPS.has(key)) {
              throw new JSEvalError(`Property '${key}' is not accessible`, node)
            }
            result[key] = prop.execute(state)
          }
        }
        return result
      })
    }

    case 'template': {
      const expressions = node.expressions.map((expression) => compileNode(expression))

      if (node.tag) {
        if (node.tag.type === 'member') {
          const tagNode = node.tag
          const object = compileNode(tagNode.object)
          const property = tagNode.computed ? compileNode(tagNode.property) : undefined
          const identifierKey = !tagNode.computed
            ? (tagNode.property as JSIdentifierNode).name
            : undefined

          return withCompiledStep(node, (state) => {
            let thisVal: unknown
            let tag: unknown
            const target = object(state)

            if (tagNode.optional && target == null) {
              tag = undefined
            } else {
              if (target == null) {
                throw new JSEvalError(
                  `Cannot read properties of ${target === null ? 'null' : 'undefined'}`,
                  tagNode,
                )
              }

              const key = property ? String(property(state)) : identifierKey!
              if (BLOCKED_PROPS.has(key)) {
                throw new JSEvalError(`Access to property '${key}' is not permitted`, tagNode)
              }

              thisVal = target
              tag = (target as any)[key]
            }

            if (typeof tag !== 'function')
              throw new JSEvalError('Template tag must be a function', node)

            const callableTag = tag as JSCallable
            ensureCallAllowed('tagged-template', callableTag, thisVal, node, state)

            const templateObject = getTaggedTemplateObject(
              node,
              state.opts.taggedTemplateArrayMode ?? 'spec',
            )
            const args = new Array<unknown>(expressions.length + 1)
            args[0] = templateObject
            for (let index = 0; index < expressions.length; index += 1) {
              args[index + 1] = expressions[index](state)
            }

            return safeCall(callableTag, thisVal, args, node, state)
          })
        }

        const tag = compileNode(node.tag)
        return withCompiledStep(node, (state) => {
          const resolvedTag = tag(state)
          if (typeof resolvedTag !== 'function') {
            throw new JSEvalError('Template tag must be a function', node)
          }

          const callableTag = resolvedTag as JSCallable
          ensureCallAllowed('tagged-template', callableTag, undefined, node, state)

          const templateObject = getTaggedTemplateObject(
            node,
            state.opts.taggedTemplateArrayMode ?? 'spec',
          )
          const args = new Array<unknown>(expressions.length + 1)
          args[0] = templateObject
          for (let index = 0; index < expressions.length; index += 1) {
            args[index + 1] = expressions[index](state)
          }

          return safeCall(callableTag, undefined, args, node, state)
        })
      }

      return withCompiledStep(node, (state) => {
        let result = ''
        for (let index = 0; index < node.quasis.length; index += 1) {
          result += node.quasis[index].cooked ?? node.quasis[index].raw
          if (index < expressions.length) result += String(expressions[index](state))
        }
        return result
      })
    }

    case 'spread':
      return withCompiledStep(node, () => {
        throw new JSEvalError('Unexpected spread expression outside of array/call/object', node)
      })

    case 'sequence': {
      const expressions = node.expressions.map((expression) => compileNode(expression))
      return withCompiledStep(node, (state) => {
        let last: unknown
        for (const expression of expressions) last = expression(state)
        return last
      })
    }

    case 'pipeline': {
      const left = compileNode(node.left)
      const right = compileNode(node.right)
      return withCompiledStep(node, (state) => {
        const value = left(state)
        state.topics.push(value)
        try {
          return right(state)
        } finally {
          state.topics.pop()
        }
      })
    }
  }
}

function compileKeyEvaluator(keyNode: JSExprNode, computed: boolean): CompiledKeyEvaluator {
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

function compileArgumentEvaluators(
  args: Array<JSExprNode | JSSpreadNode>,
): CompiledArgumentEvaluator[] {
  return args.map((arg) =>
    arg.type === 'spread'
      ? {
          node: arg,
          spread: true,
          execute: compileNode(arg.argument),
        }
      : {
          node: arg,
          spread: false,
          execute: compileNode(arg),
        },
  )
}

function evalCompiledArgs(args: CompiledArgumentEvaluator[], state: EvalState): unknown[] {
  let hasSpread = false
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].spread) {
      hasSpread = true
      break
    }
  }

  if (!hasSpread) {
    const result = new Array<unknown>(args.length)
    for (let index = 0; index < args.length; index += 1) {
      result[index] = args[index].execute(state)
    }
    return result
  }

  const result: unknown[] = []
  for (const arg of args) {
    if (arg.spread) appendIterableValues(result, arg.execute(state), arg.node, state)
    else result.push(arg.execute(state))
  }
  return result
}

function invokeCompiledCall(
  callable: JSCallable,
  thisVal: unknown,
  args: CompiledArgumentEvaluator[],
  node: JSExprNode,
  state: EvalState,
): unknown {
  switch (args.length) {
    case 0:
      return safeCall0(callable, thisVal, node, state)
    case 1:
      if (!args[0].spread) {
        return safeCall1(callable, thisVal, args[0].execute(state), node, state)
      }
      break
    case 2:
      if (!args[0].spread && !args[1].spread) {
        return safeCall2(
          callable,
          thisVal,
          args[0].execute(state),
          args[1].execute(state),
          node,
          state,
        )
      }
      break
    case 3:
      if (!args[0].spread && !args[1].spread && !args[2].spread) {
        return safeCall3(
          callable,
          thisVal,
          args[0].execute(state),
          args[1].execute(state),
          args[2].execute(state),
          node,
          state,
        )
      }
      break
    case 4:
      if (!args[0].spread && !args[1].spread && !args[2].spread && !args[3].spread) {
        return safeCall4(
          callable,
          thisVal,
          args[0].execute(state),
          args[1].execute(state),
          args[2].execute(state),
          args[3].execute(state),
          node,
          state,
        )
      }
      break
  }

  return safeCall(callable, thisVal, evalCompiledArgs(args, state), node, state)
}

function bindCompiledArrowParameters(
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

function compileArrowBinding(binding: JSBindingNode): CompiledArrowBinding {
  switch (binding.type) {
    case 'binding-identifier':
      return (value, state) => {
        ;(state.context as Record<string, unknown>)[binding.name] = value
      }

    case 'binding-assignment': {
      const left = compileArrowBinding(binding.left)
      const defaultValue = compileNode(binding.defaultValue)
      return (value, state) => {
        left(value === undefined ? defaultValue(state) : value, state)
      }
    }

    case 'binding-array': {
      const elements = binding.elements.map((element) =>
        element === null ? null : compileArrowBinding(element),
      )
      const rest = binding.rest ? compileArrowBinding(binding.rest) : null
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
        key: compileKeyEvaluator(prop.key, prop.computed),
        bind: compileArrowBinding(prop.value),
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

function getArrowExpectedArgumentCount(params: JSArrowParameterNode[]): number {
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

function collectArrowBoundNames(params: JSArrowParameterNode[]): string[] {
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

function bindArrowParameters(
  params: JSArrowParameterNode[],
  args: unknown[],
  state: EvalState,
): void {
  let argIndex = 0

  for (const param of params) {
    const value = param.rest ? args.slice(argIndex) : args[argIndex]
    if (!param.rest) argIndex += 1
    else argIndex = args.length
    bindArrowBinding(param.binding, value, state)
  }
}

function bindArrowBinding(binding: JSBindingNode, value: unknown, state: EvalState): void {
  switch (binding.type) {
    case 'binding-identifier':
      ;(state.context as Record<string, unknown>)[binding.name] = value
      return

    case 'binding-assignment':
      bindArrowBinding(
        binding.left,
        value === undefined ? evalNode(binding.defaultValue, state) : value,
        state,
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
        if (element) bindArrowBinding(element, values[index], state)
        index += 1
      }
      if (binding.rest) bindArrowBinding(binding.rest, values.slice(index), state)
      return
    }

    case 'binding-object': {
      if (value == null) {
        throw new JSEvalError('Object binding patterns cannot destructure null or undefined')
      }

      const source = Object(value) as Record<string, unknown>
      const excluded = new Set<string>()

      for (const prop of binding.properties) {
        const key = getBindingPropertyKey(prop.key, prop.computed, state)
        excluded.add(key)
        bindArrowBinding(prop.value, source[key], state)
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

function getBindingPropertyKey(keyNode: JSExprNode, computed: boolean, state: EvalState): string {
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

function evalUnary(node: JSUnaryNode, state: EvalState): unknown {
  if (node.operator === 'typeof') {
    // typeof doesn't throw on undefined identifiers
    try {
      const val = evalNode(node.operand, state)
      return typeof val
    } catch (e) {
      if (e instanceof JSEvalError && node.operand.type === 'identifier') return 'undefined'
      throw e
    }
  }
  const val = evalNode(node.operand, state)
  switch (node.operator) {
    case '!':
      return !val
    case '~':
      return ~(val as any)
    case '+':
      return +(val as any)
    case '-':
      return -(val as any)
    case 'void':
      return undefined
    case 'await':
      // In a sync evaluator, await just passes the value through.
      // Proper async support would require an async eval path.
      return val
  }
}

function evalBinary(node: JSBinaryNode, state: EvalState): unknown {
  const l = evalNode(node.left, state)
  const r = evalNode(node.right, state)
  switch (node.operator) {
    case '+':
      return (l as any) + (r as any)
    case '-':
      return (l as any) - (r as any)
    case '*':
      return (l as any) * (r as any)
    case '/':
      return (l as any) / (r as any)
    case '%':
      return (l as any) % (r as any)
    case '**':
      return (l as any) ** (r as any)
    case '&':
      return (l as any) & (r as any)
    case '|':
      return (l as any) | (r as any)
    case '^':
      return (l as any) ^ (r as any)
    case '<<':
      return (l as any) << (r as any)
    case '>>':
      return (l as any) >> (r as any)
    case '>>>':
      return (l as any) >>> (r as any)
    case '==':
      // biome-ignore lint/suspicious/noDoubleEquals: The evaluator intentionally preserves JS loose equality semantics.
      return l == r // intentional loose equality
    case '!=':
      // biome-ignore lint/suspicious/noDoubleEquals: The evaluator intentionally preserves JS loose inequality semantics.
      return l != r
    case '===':
      return l === r
    case '!==':
      return l !== r
    case '<':
      return (l as any) < (r as any)
    case '>':
      return (l as any) > (r as any)
    case '<=':
      return (l as any) <= (r as any)
    case '>=':
      return (l as any) >= (r as any)
    case 'instanceof':
      return (l as any) instanceof (r as any)
    case 'in':
      return (l as any) in (r as any)
    default:
      throw new JSEvalError(`Unknown binary operator '${node.operator}'`, node)
  }
}

function evalLogical(node: JSLogicalNode, state: EvalState): unknown {
  const l = evalNode(node.left, state)
  switch (node.operator) {
    case '&&':
      return l ? evalNode(node.right, state) : l
    case '||':
      return l ? l : evalNode(node.right, state)
    case '??':
      return l != null ? l : evalNode(node.right, state)
  }
}

function evalMember(node: JSMemberNode, state: EvalState): unknown {
  const obj = evalNode(node.object, state)

  if (node.optional && obj == null) return undefined
  if (obj == null)
    throw new JSEvalError(`Cannot read properties of ${obj === null ? 'null' : 'undefined'}`, node)

  const key = node.computed
    ? String(evalNode(node.property, state))
    : (node.property as JSIdentifierNode).name

  if (BLOCKED_PROPS.has(key))
    throw new JSEvalError(`Access to property '${key}' is not permitted`, node)

  return (obj as any)[key]
}

function evalCall(node: JSCallNode, state: EvalState): unknown {
  // Resolve callee — need the `this` context for method calls
  let thisVal: unknown
  let fn: unknown

  if (node.callee.type === 'member') {
    const memberNode = node.callee
    const obj = evalNode(memberNode.object, state)
    if (memberNode.optional && obj == null) return undefined
    if (obj == null) throw new JSEvalError('Cannot call method on null/undefined', node)

    const key = memberNode.computed
      ? String(evalNode(memberNode.property, state))
      : (memberNode.property as JSIdentifierNode).name

    if (BLOCKED_PROPS.has(key))
      throw new JSEvalError(`Access to method '${key}' is not permitted`, node)

    thisVal = obj
    fn = (obj as any)[key]
  } else {
    fn = evalNode(node.callee, state)
  }

  if (node.optional && fn == null) return undefined
  if (typeof fn !== 'function')
    throw new JSEvalError(
      `'${node.callee.type === 'identifier' ? (node.callee as JSIdentifierNode).name : 'value'}' is not a function`,
      node,
    )

  const callable = fn as JSCallable
  ensureCallAllowed('call', callable, thisVal, node, state)

  const argNodes = node.args

  switch (argNodes.length) {
    case 0:
      return safeCall0(callable, thisVal, node, state)
    case 1:
      if (argNodes[0].type !== 'spread') {
        return safeCall1(callable, thisVal, evalNode(argNodes[0], state), node, state)
      }
      break
    case 2:
      if (argNodes[0].type !== 'spread' && argNodes[1].type !== 'spread') {
        return safeCall2(
          callable,
          thisVal,
          evalNode(argNodes[0], state),
          evalNode(argNodes[1], state),
          node,
          state,
        )
      }
      break
    case 3:
      if (
        argNodes[0].type !== 'spread' &&
        argNodes[1].type !== 'spread' &&
        argNodes[2].type !== 'spread'
      ) {
        return safeCall3(
          callable,
          thisVal,
          evalNode(argNodes[0], state),
          evalNode(argNodes[1], state),
          evalNode(argNodes[2], state),
          node,
          state,
        )
      }
      break
    case 4:
      if (
        argNodes[0].type !== 'spread' &&
        argNodes[1].type !== 'spread' &&
        argNodes[2].type !== 'spread' &&
        argNodes[3].type !== 'spread'
      ) {
        return safeCall4(
          callable,
          thisVal,
          evalNode(argNodes[0], state),
          evalNode(argNodes[1], state),
          evalNode(argNodes[2], state),
          evalNode(argNodes[3], state),
          node,
          state,
        )
      }
      break
  }

  const args = evalArgs(argNodes, state)
  return safeCall(callable, thisVal, args, node, state)
}

function evalArgs(args: Array<JSExprNode | JSSpreadNode>, state: EvalState): unknown[] {
  let hasSpread = false
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].type === 'spread') {
      hasSpread = true
      break
    }
  }

  if (!hasSpread) {
    const result = new Array<unknown>(args.length)
    for (let index = 0; index < args.length; index += 1) {
      result[index] = evalNode(args[index], state)
    }
    return result
  }

  const result: unknown[] = []
  for (const arg of args) {
    if (arg.type === 'spread')
      appendIterableValues(result, evalNode(arg.argument, state), arg, state)
    else result.push(evalNode(arg, state))
  }
  return result
}

// #endregion

// #region Call execution helpers

function enterCall(node: JSExprNode, state: EvalState): void {
  const max = state.opts.maxCallDepth ?? 32
  if (state.callDepth >= max) throw new JSEvalError(`Maximum call depth (${max}) exceeded`, node)
  state.callDepth += 1
}

function leaveCall(state: EvalState): void {
  state.callDepth -= 1
}

function safeCall0(fn: JSCallable, thisVal: unknown, node: JSExprNode, state: EvalState): unknown {
  enterCall(node, state)
  try {
    return Reflect.apply(fn, thisVal, [])
  } finally {
    leaveCall(state)
  }
}

function safeCall1(
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

function safeCall2(
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

function safeCall3(
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

function safeCall4(
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

function safeCall(
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

// #endregion

// #region Template evaluation

function evalTemplate(node: JSTemplateNode, state: EvalState): unknown {
  if (node.tag) {
    let thisVal: unknown
    let tag: unknown

    if (node.tag.type === 'member') {
      const obj = evalNode(node.tag.object, state)

      if (node.tag.optional && obj == null) {
        tag = undefined
      } else {
        if (obj == null) {
          throw new JSEvalError(
            `Cannot read properties of ${obj === null ? 'null' : 'undefined'}`,
            node.tag,
          )
        }

        const key = node.tag.computed
          ? String(evalNode(node.tag.property, state))
          : (node.tag.property as JSIdentifierNode).name

        if (BLOCKED_PROPS.has(key)) {
          throw new JSEvalError(`Access to property '${key}' is not permitted`, node.tag)
        }

        thisVal = obj
        tag = (obj as any)[key]
      }
    } else {
      tag = evalNode(node.tag, state)
    }

    if (typeof tag !== 'function') throw new JSEvalError('Template tag must be a function', node)

    const callableTag = tag as JSCallable
    ensureCallAllowed('tagged-template', callableTag, thisVal, node, state)

    const templateObject = getTaggedTemplateObject(
      node,
      state.opts.taggedTemplateArrayMode ?? 'spec',
    )

    const args = new Array<unknown>(node.expressions.length + 1)
    args[0] = templateObject
    for (let index = 0; index < node.expressions.length; index += 1) {
      args[index + 1] = evalNode(node.expressions[index], state)
    }

    return safeCall(callableTag, thisVal, args, node, state)
  }

  // Untagged: interleave quasis and expressions
  let result = ''
  for (let i = 0; i < node.quasis.length; i++) {
    result += node.quasis[i].cooked ?? node.quasis[i].raw
    if (i < node.expressions.length) result += String(evalNode(node.expressions[i], state))
  }
  return result
}

// #endregion

// #region Public evaluator class

/** Evaluates expression AST nodes against a readonly scope object. */
export class JSEvaluator {
  private readonly context: Readonly<Record<string, unknown>>
  private readonly hasBaseContext: boolean
  private readonly resolvedOpts: Readonly<JSEvalOptions>

  constructor(
    context: Readonly<Record<string, unknown>> = EMPTY_CONTEXT,
    opts: JSEvalOptions = EMPTY_OPTS,
  ) {
    this.resolvedOpts = {
      ...opts,
      functionMode: opts.functionMode ?? 'default',
      rootContextMode: opts.rootContextMode ?? DEFAULT_ROOT_CONTEXT_MODE,
      objectLiteralMode: opts.objectLiteralMode ?? DEFAULT_OBJECT_LITERAL_MODE,
      isCallableAllowed: opts.isCallableAllowed ?? defaultCallPermissionPolicy,
    }
    this.context = normalizeContextRoot(
      context,
      getRootContextMode(this.resolvedOpts),
      'Base evaluation context',
    )
    this.hasBaseContext = hasOwnEnumerableKeys(this.context)
  }

  evaluate(node: JSExprNode, context: Readonly<Record<string, unknown>> = EMPTY_CONTEXT): unknown {
    const normalizedContext =
      context === EMPTY_CONTEXT
        ? EMPTY_CONTEXT
        : normalizeContextRoot(context, getRootContextMode(this.resolvedOpts), 'Evaluation context')

    const stateContext =
      normalizedContext === EMPTY_CONTEXT
        ? this.context
        : this.hasBaseContext
          ? mergeContexts(this.context, normalizedContext, getRootContextMode(this.resolvedOpts))
          : normalizedContext

    return evalNode(node, createEvalState(stateContext, this.resolvedOpts))
  }
}

// #endregion
