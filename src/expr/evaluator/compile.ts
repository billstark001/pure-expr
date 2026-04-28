import type {
  JSArrowFunctionNode,
  JSExprNode,
  JSIdentifierNode,
  JSSpreadNode,
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
  assertPropertyAllowed,
  evaluateLogicalOperator,
  resolveIdentifier,
} from './operations.js'
import { BLOCKED_PROPS } from './security.js'
import { consumeStep } from './state.js'
import { getTaggedTemplateObject } from './templates.js'
import {
  JSEvalError,
  PERFORMANCE_ARROW_RUNTIME_CACHE,
  type CompiledArgumentEvaluator,
  type CompiledArrowRuntime,
  type CompiledKeyEvaluator,
  type CompiledNodeEvaluator,
  type CompiledObjectPropertyEvaluator,
  type EvalState,
  type JSCallable,
} from './types.js'

export interface CompileRuntimeOptions {
  evalArrowFunction(node: JSArrowFunctionNode, state: EvalState): unknown
}

export interface CompileRuntime {
  compileNode(node: JSExprNode): CompiledNodeEvaluator
  getCompiledArrowRuntime(node: JSArrowFunctionNode): CompiledArrowRuntime
}

// #region Compile runtime factory

export function createCompileRuntime(options: CompileRuntimeOptions): CompileRuntime {
  const { evalArrowFunction } = options

  function withCompiledStep(
    node: JSExprNode,
    execute: CompiledNodeEvaluator,
  ): CompiledNodeEvaluator {
    return (state) => {
      consumeStep(state, node)
      return execute(state)
    }
  }

  // #region Arrow runtime compilation

  function getCompiledArrowRuntime(node: JSArrowFunctionNode): CompiledArrowRuntime {
    const cached = PERFORMANCE_ARROW_RUNTIME_CACHE.get(node)
    if (cached) return cached

    const compiled = {
      body: compileNode(node.body),
      params: node.params.map((param) => ({
        rest: param.rest,
        bind: compileArrowBinding(param.binding, compileNode),
      })),
      boundNames: collectArrowBoundNames(node.params),
      expectedArgumentCount: getArrowExpectedArgumentCount(node.params),
    } satisfies CompiledArrowRuntime

    PERFORMANCE_ARROW_RUNTIME_CACHE.set(node, compiled)
    return compiled
  }

  // #endregion

  // #region Core compilation

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
        return withCompiledStep(node, (state) => resolveIdentifier(node, state))

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
              return typeof operand(state)
            } catch (error) {
              if (error instanceof JSEvalError && node.operand.type === 'identifier') {
                return 'undefined'
              }
              throw error
            }
          }
          return applyUnaryOperator(node, operand(state))
        })
      }

      case 'binary': {
        const left = compileNode(node.left)
        const right = compileNode(node.right)
        return withCompiledStep(node, (state) =>
          applyBinaryOperator(node, left(state), right(state)),
        )
      }

      case 'logical': {
        const left = compileNode(node.left)
        const right = compileNode(node.right)
        return withCompiledStep(node, (state) =>
          evaluateLogicalOperator(node, left(state), () => right(state)),
        )
      }

      case 'conditional': {
        const test = compileNode(node.test)
        const consequent = compileNode(node.consequent)
        const alternate = compileNode(node.alternate)
        return withCompiledStep(node, (state) =>
          test(state) ? consequent(state) : alternate(state),
        )
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
          assertPropertyAllowed(key, node)
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
            assertPropertyAllowed(key, node, 'method')

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
                assertPropertyAllowed(key, tagNode)
                thisVal = target
                tag = (target as any)[key]
              }

              if (typeof tag !== 'function') {
                throw new JSEvalError('Template tag must be a function', node)
              }

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

  // #endregion

  // #region Call compilation helpers

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

  // #endregion

  return {
    compileNode,
    getCompiledArrowRuntime,
  }
}

// #endregion
