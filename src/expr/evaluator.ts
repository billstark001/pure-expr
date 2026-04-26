import { defaultCallPermissionPolicy } from './call-permission.js'
import type {
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

interface EvalState {
  context: Readonly<Record<string, unknown>>
  callDepth: number
  steps: number
  opts: Readonly<JSEvalOptions>
}

const EMPTY_CONTEXT: Readonly<Record<string, unknown>> = Object.freeze({})
const EMPTY_OPTS: Readonly<JSEvalOptions> = Object.freeze({})

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
  if (!policy({ kind, fn, thisValue, node })) {
    throw new JSEvalError('Calling this function is not permitted', node)
  }
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
  return { context, callDepth: 0, steps: 0, opts }
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
      return state.context[node.name]
    }

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
      // Hack-style: left |> right  ≡  right(left)
      const value = evalNode(node.left, state)
      const fn = evalNode(node.right, state)
      if (typeof fn !== 'function')
        throw new JSEvalError('Right-hand side of |> must be a function', node)
      const callable = fn as JSCallable
      ensureCallAllowed('pipeline', callable, undefined, node, state)
      return safeCall1(callable, undefined, value, node, state)
    }

    default: {
      const exhaustive: never = node
      throw new JSEvalError(`Unknown node type: ${(exhaustive as any).type}`, node as any)
    }
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
