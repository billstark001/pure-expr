import { JSExprNode, JSUnaryNode, JSBinaryNode, JSLogicalNode, JSMemberNode, JSIdentifierNode, JSCallNode, JSSpreadNode, JSTemplateNode } from "./node-types.js"

/** Error raised while evaluating an expression AST. */
export class JSEvalError extends Error {
  constructor(message: string, public readonly node?: JSExprNode) {
    super(message)
    this.name = 'JSEvalError'
  }
}

// Properties that could escape the sandbox or mutate the prototype chain
const BLOCKED_PROPS = new Set([
  '__proto__', '__defineGetter__', '__defineSetter__',
  '__lookupGetter__', '__lookupSetter__', 'constructor',
  'prototype',
])

// Identifiers that must never resolve from context
const BLOCKED_GLOBALS = new Set([
  'eval', 'Function', 'globalThis', 'global', 'window', 'self',
  'process', 'require', 'module', 'exports', 'Buffer',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'fetch', 'XMLHttpRequest', 'WebSocket',
  'document', 'location', 'history', 'navigator',
  'alert', 'confirm', 'prompt', 'open', 'close',
  'Proxy', 'Reflect',
])

export type TaggedTemplateArrayMode = 'spec' | 'loose'

type EmulatedTemplateStringsArray = TemplateStringsArray & {
  raw: readonly string[]
}

interface EvalState {
  context: Readonly<Record<string, unknown>>
  callDepth: number
  opts: Readonly<JSEvalOptions>
}

const EMPTY_CONTEXT: Readonly<Record<string, unknown>> = Object.freeze({})
const EMPTY_OPTS: Readonly<JSEvalOptions> = Object.freeze({})

function hasOwnEnumerableKeys(value: Readonly<Record<string, unknown>>): boolean {
  for (const key in value) {
    if (Object.hasOwn(value, key)) return true
  }
  return false
}

const SPEC_TEMPLATE_OBJECT_CACHE = new WeakMap<JSTemplateNode, EmulatedTemplateStringsArray>()
const LOOSE_TEMPLATE_OBJECT_CACHE = new WeakMap<JSTemplateNode, EmulatedTemplateStringsArray>()

function createTaggedTemplateObject(
  node: JSTemplateNode,
  mode: TaggedTemplateArrayMode
): EmulatedTemplateStringsArray {
  const cooked = node.quasis.map((quasi) => quasi.cooked === null ? undefined : quasi.cooked)
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
  mode: TaggedTemplateArrayMode
): EmulatedTemplateStringsArray {
  const cache = mode === 'loose' ? LOOSE_TEMPLATE_OBJECT_CACHE : SPEC_TEMPLATE_OBJECT_CACHE
  const cached = cache.get(node)
  if (cached) return cached

  const created = createTaggedTemplateObject(node, mode)
  cache.set(node, created)
  return created
}

/** Runtime evaluation options for JSEvaluator. */
export interface JSEvalOptions {
  allowAwait?: boolean
  allowIn?: boolean
  maxCallDepth?: number
  taggedTemplateArrayMode?: TaggedTemplateArrayMode
}

/** Internal state used during evaluation. */
export function createEvalState(context: Readonly<Record<string, unknown>>, opts: Readonly<JSEvalOptions>): EvalState {
  return { context, callDepth: 0, opts }
}

/** Evaluates a JavaScript expression node within a given state. */
export function evalNode(node: JSExprNode, state: EvalState): unknown {
  switch (node.type) {

    case 'literal': return node.value

    case 'regex': return new RegExp(node.pattern, node.flags)

    case 'identifier': {
      if (BLOCKED_GLOBALS.has(node.name))
        throw new JSEvalError(`Access to '${node.name}' is not permitted`, node)
      if (!(node.name in state.context))
        throw new JSEvalError(`'${node.name}' is not defined`, node)
      return state.context[node.name]
    }

    case 'unary': return evalUnary(node, state)
    case 'binary': return evalBinary(node, state)
    case 'logical': return evalLogical(node, state)
    case 'conditional': {
      return evalNode(node.test, state)
        ? evalNode(node.consequent, state)
        : evalNode(node.alternate, state)
    }

    case 'member': return evalMember(node, state)
    case 'call': return evalCall(node, state)

    case 'array': {
      const result: unknown[] = []
      for (const el of node.elements) {
        if (el === null) result.push(undefined)
        else if (el.type === 'spread') result.push(...(evalNode(el.argument, state) as any))
        else result.push(evalNode(el, state))
      }
      return result
    }

    case 'object': {
      const result: Record<string, unknown> = {}
      for (const prop of node.props) {
        if (prop.type === 'spread') {
          Object.assign(result, evalNode(prop.argument, state))
        } else {
          const key = prop.computed
            ? String(evalNode(prop.key, state))
            : (prop.key.type === 'identifier' ? prop.key.name : String(evalNode(prop.key, state)))
          if (BLOCKED_PROPS.has(key))
            throw new JSEvalError(`Property '${key}' is not accessible`, node)
          result[key] = evalNode(prop.value, state)
        }
      }
      return result
    }

    case 'template': return evalTemplate(node, state)

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
      return safeCall1(fn, undefined, value, node, state)
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
    case '!': return !val
    case '~': return ~(val as any)
    case '+': return +(val as any)
    case '-': return -(val as any)
    case 'void': return undefined
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
    case '+': return (l as any) + (r as any)
    case '-': return (l as any) - (r as any)
    case '*': return (l as any) * (r as any)
    case '/': return (l as any) / (r as any)
    case '%': return (l as any) % (r as any)
    case '**': return (l as any) ** (r as any)
    case '&': return (l as any) & (r as any)
    case '|': return (l as any) | (r as any)
    case '^': return (l as any) ^ (r as any)
    case '<<': return (l as any) << (r as any)
    case '>>': return (l as any) >> (r as any)
    case '>>>': return (l as any) >>> (r as any)
    case '==': return l == r   // intentional loose equality
    case '!=': return l != r
    case '===': return l === r
    case '!==': return l !== r
    case '<': return (l as any) < (r as any)
    case '>': return (l as any) > (r as any)
    case '<=': return (l as any) <= (r as any)
    case '>=': return (l as any) >= (r as any)
    case 'instanceof': return (l as any) instanceof (r as any)
    case 'in': return (r as any) !== null && typeof r === 'object' && (l as any) in (r as any)
    default:
      throw new JSEvalError(`Unknown binary operator '${node.operator}'`, node)
  }
}

function evalLogical(node: JSLogicalNode, state: EvalState): unknown {
  const l = evalNode(node.left, state)
  switch (node.operator) {
    case '&&': return l ? evalNode(node.right, state) : l
    case '||': return l ? l : evalNode(node.right, state)
    case '??': return l != null ? l : evalNode(node.right, state)
  }
}

function evalMember(node: JSMemberNode, state: EvalState): unknown {
  const obj = evalNode(node.object, state)

  if (node.optional && (obj == null)) return undefined
  if (obj == null)
    throw new JSEvalError(
      `Cannot read properties of ${obj === null ? 'null' : 'undefined'}`,
      node
    )

  const key = node.computed
    ? String(evalNode(node.property, state))
    : (node.property as JSIdentifierNode).name

  if (BLOCKED_PROPS.has(key))
    throw new JSEvalError(`Access to property '${key}' is not permitted`, node)

  return (obj as any)[key]
}

function evalCall(node: JSCallNode, state: EvalState): unknown {
  // Resolve callee — need the `this` context for method calls
  let thisVal: unknown = undefined
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
      node
    )

  const argNodes = node.args

  switch (argNodes.length) {
    case 0:
      return safeCall0(fn, thisVal, node, state)
    case 1:
      if (argNodes[0].type !== 'spread') {
        return safeCall1(fn, thisVal, evalNode(argNodes[0], state), node, state)
      }
      break
    case 2:
      if (argNodes[0].type !== 'spread' && argNodes[1].type !== 'spread') {
        return safeCall2(
          fn,
          thisVal,
          evalNode(argNodes[0], state),
          evalNode(argNodes[1], state),
          node,
          state,
        )
      }
      break
    case 3:
      if (argNodes[0].type !== 'spread' && argNodes[1].type !== 'spread' && argNodes[2].type !== 'spread') {
        return safeCall3(
          fn,
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
        argNodes[0].type !== 'spread'
        && argNodes[1].type !== 'spread'
        && argNodes[2].type !== 'spread'
        && argNodes[3].type !== 'spread'
      ) {
        return safeCall4(
          fn,
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
  return safeCall(fn, thisVal, args, node, state)
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
    if (arg.type === 'spread') result.push(...(evalNode(arg.argument, state) as any))
    else result.push(evalNode(arg, state))
  }
  return result
}

function enterCall(node: JSExprNode, state: EvalState): void {
  const max = state.opts.maxCallDepth ?? 32
  if (state.callDepth >= max)
    throw new JSEvalError(`Maximum call depth (${max}) exceeded`, node)
  state.callDepth += 1
}

function leaveCall(state: EvalState): void {
  state.callDepth -= 1
}

function safeCall0(
  fn: Function,
  thisVal: unknown,
  node: JSExprNode,
  state: EvalState,
): unknown {
  enterCall(node, state)
  try {
    return fn.call(thisVal)
  } finally {
    leaveCall(state)
  }
}

function safeCall1(
  fn: Function,
  thisVal: unknown,
  arg0: unknown,
  node: JSExprNode,
  state: EvalState,
): unknown {
  enterCall(node, state)
  try {
    return fn.call(thisVal, arg0)
  } finally {
    leaveCall(state)
  }
}

function safeCall2(
  fn: Function,
  thisVal: unknown,
  arg0: unknown,
  arg1: unknown,
  node: JSExprNode,
  state: EvalState,
): unknown {
  enterCall(node, state)
  try {
    return fn.call(thisVal, arg0, arg1)
  } finally {
    leaveCall(state)
  }
}

function safeCall3(
  fn: Function,
  thisVal: unknown,
  arg0: unknown,
  arg1: unknown,
  arg2: unknown,
  node: JSExprNode,
  state: EvalState,
): unknown {
  enterCall(node, state)
  try {
    return fn.call(thisVal, arg0, arg1, arg2)
  } finally {
    leaveCall(state)
  }
}

function safeCall4(
  fn: Function,
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
    return fn.call(thisVal, arg0, arg1, arg2, arg3)
  } finally {
    leaveCall(state)
  }
}

function safeCall(
  fn: Function,
  thisVal: unknown,
  args: unknown[],
  node: JSExprNode,
  state: EvalState,
): unknown {
  enterCall(node, state)
  try {
    switch (args.length) {
      case 0: return fn.call(thisVal)
      case 1: return fn.call(thisVal, args[0])
      case 2: return fn.call(thisVal, args[0], args[1])
      case 3: return fn.call(thisVal, args[0], args[1], args[2])
      case 4: return fn.call(thisVal, args[0], args[1], args[2], args[3])
      default: return fn.apply(thisVal, args)
    }
  } finally {
    leaveCall(state)
  }
}

function evalTemplate(
  node: JSTemplateNode,
  state: EvalState
): unknown {
  if (node.tag) {
    const tag = evalNode(node.tag, state)
    if (typeof tag !== 'function')
      throw new JSEvalError('Template tag must be a function', node)

    const templateObject = getTaggedTemplateObject(
      node,
      state.opts.taggedTemplateArrayMode ?? 'spec'
    )

    const args = new Array<unknown>(node.expressions.length + 1)
    args[0] = templateObject
    for (let index = 0; index < node.expressions.length; index += 1) {
      args[index + 1] = evalNode(node.expressions[index], state)
    }

    return safeCall(tag, undefined, args, node, state)
  }

  // Untagged: interleave quasis and expressions
  let result = ''
  for (let i = 0; i < node.quasis.length; i++) {
    result += node.quasis[i].cooked ?? node.quasis[i].raw
    if (i < node.expressions.length) result += String(evalNode(node.expressions[i], state))
  }
  return result
}


/** Evaluates expression AST nodes against a readonly scope object. */
export class JSEvaluator {
  private readonly hasBaseContext: boolean
  private readonly resolvedOpts: Readonly<JSEvalOptions>

  constructor(
    private readonly context: Readonly<Record<string, unknown>> = EMPTY_CONTEXT,
    opts: JSEvalOptions = EMPTY_OPTS
  ) {
    this.hasBaseContext = hasOwnEnumerableKeys(context)
    this.resolvedOpts = opts
  }

  evaluate(
    node: JSExprNode,
    context: Readonly<Record<string, unknown>> = EMPTY_CONTEXT
  ): unknown {
    const stateContext = context === EMPTY_CONTEXT
      ? this.context
      : this.hasBaseContext
        ? { ...this.context, ...context }
        : context

    return evalNode(node, createEvalState(stateContext, this.resolvedOpts))
  }

}