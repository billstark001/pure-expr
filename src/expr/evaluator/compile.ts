import type {
  ArrowFunctionExpression,
  CallExpression,
  ExpressionNode,
  Identifier,
  MemberExpression,
  SpreadElement,
} from '../node-types.js'
import {
  collectArrowBoundNames,
  compileArrowBinding,
  getArrowExpectedArgumentCount,
} from './arrows.js'
import {
  appendIterableValues,
  ensureCallAllowed,
  safeCall,
  safeCall0,
  safeCall1,
  safeCall2,
  safeCall3,
  safeCall4,
} from './calls.js'
import { copySpreadProperties, createObjectLiteralResult, getObjectLiteralMode } from './context.js'
import {
  applyBinaryOperator,
  applyUnaryOperator,
  evaluateLogicalOperator,
  readProperty,
  resolveIdentifier,
} from './operations.js'
import { BLOCKED_PROPS } from './security.js'
import { consumeStep } from './state.js'
import { getTaggedTemplateObject } from './templates.js'
import {
  type CompiledArgumentEvaluator,
  type CompiledArrowRuntime,
  type CompiledKeyEvaluator,
  type CompiledNodeEvaluator,
  type CompiledObjectPropertyEvaluator,
  type EvalState,
  type JSCallable,
  JSEvalError,
  PERFORMANCE_ARROW_RUNTIME_CACHE,
} from './types.js'

export interface CompileRuntimeOptions {
  evalArrowFunction(node: ArrowFunctionExpression, state: EvalState): unknown
  trackSteps?: boolean
}

export interface CompileRuntime {
  compileNode(node: ExpressionNode): CompiledNodeEvaluator
  getCompiledArrowRuntime(node: ArrowFunctionExpression): CompiledArrowRuntime
}

const CHAIN_SHORT_CIRCUIT = Symbol('pure-expr.compiled-chain-short-circuit')

export function createCompileRuntime(options: CompileRuntimeOptions): CompileRuntime {
  const { evalArrowFunction } = options

  function withCompiledStep(
    node: ExpressionNode,
    execute: CompiledNodeEvaluator,
  ): CompiledNodeEvaluator {
    if (options.trackSteps === false) return execute
    return (state) => {
      consumeStep(state, node)
      return execute(state)
    }
  }

  function getCompiledArrowRuntime(node: ArrowFunctionExpression): CompiledArrowRuntime {
    const cached = PERFORMANCE_ARROW_RUNTIME_CACHE.get(node)
    if (cached) return cached
    const compiled = {
      body: compileNode(node.body),
      params: node.params.map((param) => ({
        rest: param.type === 'RestElement',
        bind: compileArrowBinding(param, compileNode),
      })),
      boundNames: collectArrowBoundNames(node.params),
      expectedArgumentCount: getArrowExpectedArgumentCount(node.params),
    } satisfies CompiledArrowRuntime
    PERFORMANCE_ARROW_RUNTIME_CACHE.set(node, compiled)
    return compiled
  }

  function compileNode(node: ExpressionNode): CompiledNodeEvaluator {
    switch (node.type) {
      case 'Literal':
        if ('regex' in node) {
          return withCompiledStep(node, (state) => {
            if (state.opts.allowRegexLiterals === false) {
              throw new JSEvalError('Regular expression literals are not enabled', node)
            }
            return new RegExp(node.regex.pattern, node.regex.flags)
          })
        }
        return withCompiledStep(node, () => node.value)
      case 'Identifier':
        return withCompiledStep(node, (state) => resolveIdentifier(node, state))
      case 'TopicReference':
        return withCompiledStep(node, (state) => {
          if (state.topics.length === 0) {
            throw new JSEvalError(
              "Topic reference '%' is only available inside a pipeline body",
              node,
            )
          }
          return state.topics[state.topics.length - 1]
        })
      case 'ArrowFunctionExpression':
        return withCompiledStep(node, (state) => evalArrowFunction(node, state))
      case 'UnaryExpression': {
        const argument = compileNode(node.argument)
        return withCompiledStep(node, (state) => {
          if (node.operator === 'typeof') {
            try {
              return typeof argument(state)
            } catch (error) {
              if (error instanceof JSEvalError && node.argument.type === 'Identifier')
                return 'undefined'
              throw error
            }
          }
          return applyUnaryOperator(node, argument(state))
        })
      }
      case 'AwaitExpression': {
        const argument = compileNode(node.argument)
        return withCompiledStep(node, argument)
      }
      case 'BinaryExpression': {
        const left = compileNode(node.left)
        const right = compileNode(node.right)
        return withCompiledStep(node, (state) =>
          applyBinaryOperator(node, left(state), right(state)),
        )
      }
      case 'LogicalExpression': {
        const left = compileNode(node.left)
        const right = compileNode(node.right)
        return withCompiledStep(node, (state) =>
          evaluateLogicalOperator(node, left(state), () => right(state)),
        )
      }
      case 'ConditionalExpression': {
        const test = compileNode(node.test)
        const consequent = compileNode(node.consequent)
        const alternate = compileNode(node.alternate)
        return withCompiledStep(node, (state) =>
          test(state) ? consequent(state) : alternate(state),
        )
      }
      case 'MemberExpression': {
        const object = compileNode(node.object)
        const key = compileMemberKey(node)
        return withCompiledStep(node, (state) => {
          const target = object(state)
          if (node.optional && target == null) return undefined
          if (target == null) {
            throw new JSEvalError(
              `Cannot read properties of ${target === null ? 'null' : 'undefined'}`,
              node,
            )
          }
          return readProperty(target, key(state), node, state)
        })
      }
      case 'CallExpression':
        return compileCall(node)
      case 'ChainExpression': {
        const expression = compileChainElement(node.expression)
        return (state) => {
          const value = expression(state)
          return value === CHAIN_SHORT_CIRCUIT ? undefined : value
        }
      }
      case 'ArrayExpression': {
        const elements = node.elements.map((element) =>
          element === null
            ? null
            : compileNode(element.type === 'SpreadElement' ? element.argument : element),
        )
        return withCompiledStep(node, (state) => {
          const result: unknown[] = []
          for (let index = 0; index < node.elements.length; index += 1) {
            consumeStep(state, node)
            const element = node.elements[index]
            const execute = elements[index]
            if (element === null || execute === null) result.push(undefined)
            else if (element.type === 'SpreadElement')
              appendIterableValues(result, execute(state), element, state)
            else result.push(execute(state))
          }
          return result
        })
      }
      case 'ObjectExpression': {
        const properties = node.properties.map((property) =>
          property.type === 'SpreadElement'
            ? ({
                spread: true,
                execute: compileNode(property.argument),
              } satisfies CompiledObjectPropertyEvaluator)
            : ({
                spread: false,
                key: compileKeyEvaluator(property.key, property.computed),
                execute: compileNode(property.value),
              } satisfies CompiledObjectPropertyEvaluator),
        )
        return withCompiledStep(node, (state) => {
          const result = createObjectLiteralResult(getObjectLiteralMode(state.opts))
          for (const property of properties) {
            if (property.spread) copySpreadProperties(result, property.execute(state), node, state)
            else {
              consumeStep(state, node)
              const key = property.key!(state)
              if (BLOCKED_PROPS.has(key))
                throw new JSEvalError(`Property '${key}' is not accessible`, node)
              result[key] = property.execute(state)
            }
          }
          return result
        })
      }
      case 'TemplateLiteral': {
        const expressions = node.expressions.map(compileNode)
        return withCompiledStep(node, (state) => {
          let result = ''
          for (let index = 0; index < node.quasis.length; index += 1) {
            result += node.quasis[index].value.cooked ?? node.quasis[index].value.raw
            if (index < expressions.length) result += String(expressions[index](state))
          }
          return result
        })
      }
      case 'TaggedTemplateExpression': {
        const expressions = node.quasi.expressions.map(compileNode)
        const invoke = (tag: unknown, thisValue: unknown, state: EvalState): unknown => {
          if (typeof tag !== 'function')
            throw new JSEvalError('Template tag must be a function', node)
          const callable = tag as JSCallable
          ensureCallAllowed('tagged-template', callable, thisValue, node, state)
          const args = new Array<unknown>(expressions.length + 1)
          args[0] = getTaggedTemplateObject(
            node.quasi,
            state.opts.taggedTemplateArrayMode ?? 'spec',
          )
          for (let index = 0; index < expressions.length; index += 1)
            args[index + 1] = expressions[index](state)
          return safeCall(callable, thisValue, args, node, state)
        }
        if (node.tag.type === 'MemberExpression') {
          const tag = node.tag
          const object = compileNode(tag.object)
          const key = compileMemberKey(tag)
          return withCompiledStep(node, (state) => {
            const target = object(state)
            if (target == null) {
              throw new JSEvalError(
                `Cannot read properties of ${target === null ? 'null' : 'undefined'}`,
                tag,
              )
            }
            return invoke(readProperty(target, key(state), tag, state, 'method'), target, state)
          })
        }
        const tag = compileNode(node.tag)
        return withCompiledStep(node, (state) => invoke(tag(state), undefined, state))
      }
      case 'SpreadElement':
        return withCompiledStep(node, () => {
          throw new JSEvalError('Unexpected spread expression outside of array/call/object', node)
        })
      case 'SequenceExpression': {
        const expressions = node.expressions.map(compileNode)
        return withCompiledStep(node, (state) => {
          let last: unknown
          for (const expression of expressions) last = expression(state)
          return last
        })
      }
      case 'PipelineExpression': {
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

  function compileCall(node: CallExpression): CompiledNodeEvaluator {
    const args = compileArgumentEvaluators(node.arguments)
    if (node.callee.type === 'MemberExpression') {
      const member = node.callee
      const object = compileNode(member.object)
      const key = compileMemberKey(member)
      return withCompiledStep(node, (state) => {
        const target = object(state)
        if (member.optional && target == null) return undefined
        if (target == null) throw new JSEvalError('Cannot call method on null/undefined', node)
        const fn = readProperty(target, key(state), node, state, 'method')
        if (node.optional && fn == null) return undefined
        return invokeCompiledCall(fn, target, args, node, state)
      })
    }
    const callee = compileNode(node.callee)
    return withCompiledStep(node, (state) => {
      const fn = callee(state)
      if (node.optional && fn == null) return undefined
      return invokeCompiledCall(fn, undefined, args, node, state)
    })
  }

  function compileChainElement(node: MemberExpression | CallExpression): CompiledNodeEvaluator {
    if (node.type === 'MemberExpression') {
      const object = compileChainChild(node.object)
      const key = compileMemberKey(node)
      return (state) => {
        consumeStep(state, node)
        const target = object(state)
        if (target === CHAIN_SHORT_CIRCUIT) return target
        if (node.optional && target == null) return CHAIN_SHORT_CIRCUIT
        if (target == null)
          throw new JSEvalError(
            `Cannot read properties of ${target === null ? 'null' : 'undefined'}`,
            node,
          )
        return readProperty(target, key(state), node, state)
      }
    }
    const args = compileArgumentEvaluators(node.arguments)
    if (node.callee.type === 'MemberExpression') {
      const member = node.callee
      const object = compileChainChild(member.object)
      const key = compileMemberKey(member)
      return (state) => {
        consumeStep(state, node)
        const target = object(state)
        if (target === CHAIN_SHORT_CIRCUIT) return target
        if (member.optional && target == null) return CHAIN_SHORT_CIRCUIT
        if (target == null) throw new JSEvalError('Cannot call method on null/undefined', node)
        const fn = readProperty(target, key(state), node, state, 'method')
        if (node.optional && fn == null) return CHAIN_SHORT_CIRCUIT
        return invokeCompiledCall(fn, target, args, node, state)
      }
    }
    const callee = compileChainChild(node.callee)
    return (state) => {
      consumeStep(state, node)
      const fn = callee(state)
      if (fn === CHAIN_SHORT_CIRCUIT) return fn
      if (node.optional && fn == null) return CHAIN_SHORT_CIRCUIT
      return invokeCompiledCall(fn, undefined, args, node, state)
    }
  }

  function compileChainChild(node: ExpressionNode): CompiledNodeEvaluator {
    return node.type === 'MemberExpression' || node.type === 'CallExpression'
      ? compileChainElement(node)
      : compileNode(node)
  }

  function compileMemberKey(node: MemberExpression): CompiledKeyEvaluator {
    if (!node.computed) {
      const key = (node.property as Identifier).name
      return () => key
    }
    const property = compileNode(node.property)
    return (state) => String(property(state))
  }

  function compileKeyEvaluator(node: ExpressionNode, computed: boolean): CompiledKeyEvaluator {
    if (!computed && node.type === 'Identifier') {
      const key = node.name
      return () => key
    }
    const execute = compileNode(node)
    return (state) => String(execute(state))
  }

  function compileArgumentEvaluators(
    args: Array<ExpressionNode | SpreadElement>,
  ): CompiledArgumentEvaluator[] {
    return args.map((argument) =>
      argument.type === 'SpreadElement'
        ? { node: argument, spread: true, execute: compileNode(argument.argument) }
        : { node: argument, spread: false, execute: compileNode(argument) },
    )
  }

  function evalCompiledArgs(args: CompiledArgumentEvaluator[], state: EvalState): unknown[] {
    const result: unknown[] = []
    for (const argument of args) {
      if (argument.spread)
        appendIterableValues(result, argument.execute(state), argument.node, state)
      else result.push(argument.execute(state))
    }
    return result
  }

  function invokeCompiledCall(
    fn: unknown,
    thisValue: unknown,
    args: CompiledArgumentEvaluator[],
    node: CallExpression,
    state: EvalState,
  ): unknown {
    if (typeof fn !== 'function') {
      throw new JSEvalError(
        `'${node.callee.type === 'Identifier' ? node.callee.name : 'value'}' is not a function`,
        node,
      )
    }
    const callable = fn as JSCallable
    ensureCallAllowed('call', callable, thisValue, node, state)
    switch (args.length) {
      case 0:
        return safeCall0(callable, thisValue, node, state)
      case 1:
        if (!args[0].spread)
          return safeCall1(callable, thisValue, args[0].execute(state), node, state)
        break
      case 2:
        if (!args[0].spread && !args[1].spread) {
          return safeCall2(
            callable,
            thisValue,
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
            thisValue,
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
            thisValue,
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
    return safeCall(callable, thisValue, evalCompiledArgs(args, state), node, state)
  }

  return { compileNode, getCompiledArrowRuntime }
}
