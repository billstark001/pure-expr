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

/** Evaluates expression AST nodes against a readonly scope object. */
export class JSEvaluator {
  constructor(
    private readonly context: Readonly<Record<string, unknown>> = {},
    private readonly opts: JSEvalOptions = {}
  ) {}

  eval(node: JSExprNode): unknown {
    return this.evaluate(node, this.context)
  }

  evaluate(
    node: JSExprNode,
    context: Readonly<Record<string, unknown>> = {}
  ): unknown {
    return this.evalNode(node, { context, callDepth: 0 })
  }

  private evalNode(node: JSExprNode, state: EvalState): unknown {
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

      case 'unary': return this.evalUnary(node, state)
      case 'binary': return this.evalBinary(node, state)
      case 'logical': return this.evalLogical(node, state)
      case 'conditional': {
        return this.evalNode(node.test, state)
          ? this.evalNode(node.consequent, state)
          : this.evalNode(node.alternate, state)
      }

      case 'member': return this.evalMember(node, state)
      case 'call': return this.evalCall(node, state)

      case 'array': {
        const result: unknown[] = []
        for (const el of node.elements) {
          if (el === null) result.push(undefined)
          else if (el.type === 'spread') result.push(...(this.evalNode(el.argument, state) as any))
          else result.push(this.evalNode(el, state))
        }
        return result
      }

      case 'object': {
        const result: Record<string, unknown> = {}
        for (const prop of node.props) {
          if (prop.type === 'spread') {
            Object.assign(result, this.evalNode(prop.argument, state))
          } else {
            const key = prop.computed
              ? String(this.evalNode(prop.key, state))
              : (prop.key.type === 'identifier' ? prop.key.name : String(this.evalNode(prop.key, state)))
            if (BLOCKED_PROPS.has(key))
              throw new JSEvalError(`Property '${key}' is not accessible`, node)
            result[key] = this.evalNode(prop.value, state)
          }
        }
        return result
      }

      case 'template': return this.evalTemplate(node, state)

      case 'spread':
        throw new JSEvalError('Unexpected spread expression outside of array/call/object', node)

      case 'sequence': {
        let last: unknown
        for (const expr of node.expressions) last = this.evalNode(expr, state)
        return last
      }

      case 'pipeline': {
        // Hack-style: left |> right  ≡  right(left)
        const value = this.evalNode(node.left, state)
        const fn = this.evalNode(node.right, state)
        if (typeof fn !== 'function')
          throw new JSEvalError('Right-hand side of |> must be a function', node)
        return this.safeCall(fn, undefined, [value], node, state)
      }

      default: {
        const exhaustive: never = node
        throw new JSEvalError(`Unknown node type: ${(exhaustive as any).type}`, node as any)
      }
    }
  }

  private evalUnary(node: JSUnaryNode, state: EvalState): unknown {
    if (node.operator === 'typeof') {
      // typeof doesn't throw on undefined identifiers
      try {
        const val = this.evalNode(node.operand, state)
        return typeof val
      } catch (e) {
        if (e instanceof JSEvalError && node.operand.type === 'identifier') return 'undefined'
        throw e
      }
    }
    const val = this.evalNode(node.operand, state)
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

  private evalBinary(node: JSBinaryNode, state: EvalState): unknown {
    const l = this.evalNode(node.left, state)
    const r = this.evalNode(node.right, state)
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

  private evalLogical(node: JSLogicalNode, state: EvalState): unknown {
    const l = this.evalNode(node.left, state)
    switch (node.operator) {
      case '&&': return l ? this.evalNode(node.right, state) : l
      case '||': return l ? l : this.evalNode(node.right, state)
      case '??': return l != null ? l : this.evalNode(node.right, state)
    }
  }

  private evalMember(node: JSMemberNode, state: EvalState): unknown {
    const obj = this.evalNode(node.object, state)

    if (node.optional && (obj == null)) return undefined
    if (obj == null)
      throw new JSEvalError(
        `Cannot read properties of ${obj === null ? 'null' : 'undefined'}`,
        node
      )

    const key = node.computed
      ? String(this.evalNode(node.property, state))
      : (node.property as JSIdentifierNode).name

    if (BLOCKED_PROPS.has(key))
      throw new JSEvalError(`Access to property '${key}' is not permitted`, node)

    return (obj as any)[key]
  }

  private evalCall(node: JSCallNode, state: EvalState): unknown {
    // Resolve callee — need the `this` context for method calls
    let thisVal: unknown = undefined
    let fn: unknown

    if (node.callee.type === 'member') {
      const memberNode = node.callee
      const obj = this.evalNode(memberNode.object, state)
      if (memberNode.optional && obj == null) return undefined
      if (obj == null) throw new JSEvalError('Cannot call method on null/undefined', node)

      const key = memberNode.computed
        ? String(this.evalNode(memberNode.property, state))
        : (memberNode.property as JSIdentifierNode).name

      if (BLOCKED_PROPS.has(key))
        throw new JSEvalError(`Access to method '${key}' is not permitted`, node)

      thisVal = obj
      fn = (obj as any)[key]
    } else {
      fn = this.evalNode(node.callee, state)
    }

    if (node.optional && fn == null) return undefined
    if (typeof fn !== 'function')
      throw new JSEvalError(
        `'${node.callee.type === 'identifier' ? (node.callee as JSIdentifierNode).name : 'value'}' is not a function`,
        node
      )

    const args = this.evalArgs(node.args, state)
    return this.safeCall(fn, thisVal, args, node, state)
  }

  private evalArgs(args: Array<JSExprNode | JSSpreadNode>, state: EvalState): unknown[] {
    const result: unknown[] = []
    for (const arg of args) {
      if (arg.type === 'spread') result.push(...(this.evalNode(arg.argument, state) as any))
      else result.push(this.evalNode(arg, state))
    }
    return result
  }

  private safeCall(
    fn: Function,
    thisVal: unknown,
    args: unknown[],
    node: JSExprNode,
    state: EvalState
  ): unknown {
    const max = this.opts.maxCallDepth ?? 32
    if (state.callDepth >= max)
      throw new JSEvalError(`Maximum call depth (${max}) exceeded`, node)
    state.callDepth++
    try {
      return fn.apply(thisVal, args)
    } finally {
      state.callDepth--
    }
  }

  private evalTemplate(node: JSTemplateNode, state: EvalState): unknown {
    const parts = node.expressions.map((expression) => this.evalNode(expression, state))

    if (node.tag) {
      const tag = this.evalNode(node.tag, state)
      if (typeof tag !== 'function')
        throw new JSEvalError('Template tag must be a function', node)

      const templateObject = getTaggedTemplateObject(
        node,
        this.opts.taggedTemplateArrayMode ?? 'spec'
      )

      return this.safeCall(tag, undefined, [templateObject, ...parts], node, state)
    }

    // Untagged: interleave quasis and expressions
    let result = ''
    for (let i = 0; i < node.quasis.length; i++) {
      result += node.quasis[i].cooked ?? node.quasis[i].raw
      if (i < parts.length) result += String(parts[i])
    }
    return result
  }
}