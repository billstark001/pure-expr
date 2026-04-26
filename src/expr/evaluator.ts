import { JSExprNode, JSUnaryNode, JSBinaryNode, JSLogicalNode, JSMemberNode, JSIdentifierNode, JSCallNode, JSSpreadNode, JSTemplateNode } from "./node-types.js"

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

export interface JSEvalOptions {
  allowAwait?: boolean
  allowIn?: boolean
  maxCallDepth?: number
}

export class JSEvaluator {
  private callDepth = 0

  constructor(
    private readonly context: Readonly<Record<string, unknown>>,
    private readonly opts: JSEvalOptions = {}
  ) {}

  eval(node: JSExprNode): unknown {
    switch (node.type) {

      case 'literal': return node.value

      case 'regex': return new RegExp(node.pattern, node.flags)

      case 'identifier': {
        if (BLOCKED_GLOBALS.has(node.name))
          throw new JSEvalError(`Access to '${node.name}' is not permitted`, node)
        if (!(node.name in this.context))
          throw new JSEvalError(`'${node.name}' is not defined`, node)
        return this.context[node.name]
      }

      case 'unary': return this.evalUnary(node)
      case 'binary': return this.evalBinary(node)
      case 'logical': return this.evalLogical(node)
      case 'conditional': {
        return this.eval(node.test) ? this.eval(node.consequent) : this.eval(node.alternate)
      }

      case 'member': return this.evalMember(node)
      case 'call': return this.evalCall(node)

      case 'array': {
        const result: unknown[] = []
        for (const el of node.elements) {
          if (el === null) result.push(undefined)
          else if (el.type === 'spread') result.push(...(this.eval(el.argument) as any))
          else result.push(this.eval(el))
        }
        return result
      }

      case 'object': {
        const result: Record<string, unknown> = {}
        for (const prop of node.props) {
          if (prop.type === 'spread') {
            Object.assign(result, this.eval(prop.argument))
          } else {
            const key = prop.computed
              ? String(this.eval(prop.key))
              : (prop.key.type === 'identifier' ? prop.key.name : String(this.eval(prop.key)))
            if (BLOCKED_PROPS.has(key))
              throw new JSEvalError(`Property '${key}' is not accessible`, node)
            result[key] = this.eval(prop.value)
          }
        }
        return result
      }

      case 'template': return this.evalTemplate(node)

      case 'spread':
        throw new JSEvalError('Unexpected spread expression outside of array/call/object', node)

      case 'sequence': {
        let last: unknown
        for (const expr of node.expressions) last = this.eval(expr)
        return last
      }

      case 'pipeline': {
        // Hack-style: left |> right  ≡  right(left)
        const value = this.eval(node.left)
        const fn = this.eval(node.right)
        if (typeof fn !== 'function')
          throw new JSEvalError('Right-hand side of |> must be a function', node)
        return this.safeCall(fn, undefined, [value], node)
      }

      default: {
        const exhaustive: never = node
        throw new JSEvalError(`Unknown node type: ${(exhaustive as any).type}`, node as any)
      }
    }
  }

  private evalUnary(node: JSUnaryNode): unknown {
    if (node.operator === 'typeof') {
      // typeof doesn't throw on undefined identifiers
      try {
        const val = this.eval(node.operand)
        return typeof val
      } catch (e) {
        if (e instanceof JSEvalError && node.operand.type === 'identifier') return 'undefined'
        throw e
      }
    }
    const val = this.eval(node.operand)
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

  private evalBinary(node: JSBinaryNode): unknown {
    const l = this.eval(node.left)
    const r = this.eval(node.right)
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

  private evalLogical(node: JSLogicalNode): unknown {
    const l = this.eval(node.left)
    switch (node.operator) {
      case '&&': return l ? this.eval(node.right) : l
      case '||': return l ? l : this.eval(node.right)
      case '??': return l != null ? l : this.eval(node.right)
    }
  }

  private evalMember(node: JSMemberNode): unknown {
    const obj = this.eval(node.object)

    if (node.optional && (obj == null)) return undefined
    if (obj == null)
      throw new JSEvalError(
        `Cannot read properties of ${obj === null ? 'null' : 'undefined'}`,
        node
      )

    const key = node.computed
      ? String(this.eval(node.property))
      : (node.property as JSIdentifierNode).name

    if (BLOCKED_PROPS.has(key))
      throw new JSEvalError(`Access to property '${key}' is not permitted`, node)

    return (obj as any)[key]
  }

  private evalCall(node: JSCallNode): unknown {
    // Resolve callee — need the `this` context for method calls
    let thisVal: unknown = undefined
    let fn: unknown

    if (node.callee.type === 'member') {
      const memberNode = node.callee
      const obj = this.eval(memberNode.object)
      if (memberNode.optional && obj == null) return undefined
      if (obj == null) throw new JSEvalError('Cannot call method on null/undefined', node)

      const key = memberNode.computed
        ? String(this.eval(memberNode.property))
        : (memberNode.property as JSIdentifierNode).name

      if (BLOCKED_PROPS.has(key))
        throw new JSEvalError(`Access to method '${key}' is not permitted`, node)

      thisVal = obj
      fn = (obj as any)[key]
    } else {
      fn = this.eval(node.callee)
    }

    if (node.optional && fn == null) return undefined
    if (typeof fn !== 'function')
      throw new JSEvalError(
        `'${node.callee.type === 'identifier' ? (node.callee as JSIdentifierNode).name : 'value'}' is not a function`,
        node
      )

    const args = this.evalArgs(node.args)
    return this.safeCall(fn, thisVal, args, node)
  }

  private evalArgs(args: Array<JSExprNode | JSSpreadNode>): unknown[] {
    const result: unknown[] = []
    for (const arg of args) {
      if (arg.type === 'spread') result.push(...(this.eval(arg.argument) as any))
      else result.push(this.eval(arg))
    }
    return result
  }

  private safeCall(fn: Function, thisVal: unknown, args: unknown[], node: JSExprNode): unknown {
    const max = this.opts.maxCallDepth ?? 32
    if (this.callDepth >= max)
      throw new JSEvalError(`Maximum call depth (${max}) exceeded`, node)
    this.callDepth++
    try {
      return fn.apply(thisVal, args)
    } finally {
      this.callDepth--
    }
  }

  private evalTemplate(node: JSTemplateNode): unknown {
    const parts = node.expressions.map(e => this.eval(e))

    if (node.tag) {
      const tag = this.eval(node.tag)
      if (typeof tag !== 'function')
        throw new JSEvalError('Template tag must be a function', node)
      const cookedArr = Object.assign(
        node.quasis.map(q => q.cooked),
        { raw: node.quasis.map(q => q.raw) }
      )
      return this.safeCall(tag, undefined, [cookedArr, ...parts], node)
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