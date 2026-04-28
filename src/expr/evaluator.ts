import { defaultCallPermissionPolicy } from './call-permission.js'
import type {
  JSArrowFunctionNode,
  JSBinaryNode,
  JSCallNode,
  JSExprNode,
  JSIdentifierNode,
  JSLogicalNode,
  JSMemberNode,
  JSSpreadNode,
  JSTemplateNode,
  JSUnaryNode,
} from './node-types.js'
import {
  bindArrowParameters,
  bindCompiledArrowParameters,
  collectArrowBoundNames,
  createPureExprArrowFunction,
  getArrowExpectedArgumentCount,
} from './evaluator/arrows.js'
import {
  appendIterableValues,
  ensureCallAllowed,
  safeCall,
  safeCall0,
  safeCall1,
  safeCall2,
  safeCall3,
  safeCall4,
} from './evaluator/calls.js'
import { createCompileRuntime } from './evaluator/compile.js'
import {
  cloneContextRecord,
  copySpreadProperties,
  createObjectLiteralResult,
  getObjectLiteralMode,
  getRootContextMode,
  hasOwnEnumerableKeys,
  mergeContexts,
  normalizeContextRoot,
} from './evaluator/context.js'
import {
  applyBinaryOperator,
  applyUnaryOperator,
  assertPropertyAllowed,
  evaluateLogicalOperator,
  resolveIdentifier,
} from './evaluator/operations.js'
import { BLOCKED_PROPS } from './evaluator/security.js'
import { createEvalState, consumeStep } from './evaluator/state.js'
import { getTaggedTemplateObject } from './evaluator/templates.js'
import {
  DEFAULT_OBJECT_LITERAL_MODE,
  DEFAULT_ROOT_CONTEXT_MODE,
  EMPTY_CONTEXT,
  EMPTY_OPTS,
  JSEvalError,
  UNINITIALIZED_ARROW_PARAM,
  type EvalState,
  type JSEvalOptions,
  type JSCallable,
} from './evaluator/types.js'

// #region Public exports

export { createEvalState } from './evaluator/state.js'
export {
  allowAllCalls,
  JSEvalError,
  type FunctionMode,
  type JSCallKind,
  type JSCallPermissionContext,
  type JSCallPermissionPolicy,
  type JSEvalOptions,
  type ObjectLiteralMode,
  type RootContextMode,
  type TaggedTemplateArrayMode,
} from './evaluator/types.js'

// #endregion

// #region Core evaluation

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

    case 'identifier':
      return resolveIdentifier(node, state)

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
    case 'conditional':
      return evalNode(node.test, state)
        ? evalNode(node.consequent, state)
        : evalNode(node.alternate, state)

    case 'member':
      return evalMember(node, state)
    case 'call':
      return evalCall(node, state)

    case 'array': {
      const result: unknown[] = []
      for (const element of node.elements) {
        consumeStep(state, node)
        if (element === null) result.push(undefined)
        else if (element.type === 'spread') {
          appendIterableValues(result, evalNode(element.argument, state), element, state)
        } else {
          result.push(evalNode(element, state))
        }
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
          if (BLOCKED_PROPS.has(key)) {
            throw new JSEvalError(`Property '${key}' is not accessible`, node)
          }
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
      for (const expression of node.expressions) last = evalNode(expression, state)
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

// #endregion

// #region Arrow evaluation

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
    bindArrowParameters(node.params, args, callState, evalNode)
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

// #endregion

// #region Compiled evaluation

const { getCompiledArrowRuntime } = createCompileRuntime({
  evalArrowFunction,
})

// #endregion

// #region Runtime evaluation helpers

function evalUnary(node: JSUnaryNode, state: EvalState): unknown {
  if (node.operator === 'typeof') {
    try {
      return typeof evalNode(node.operand, state)
    } catch (error) {
      if (error instanceof JSEvalError && node.operand.type === 'identifier') return 'undefined'
      throw error
    }
  }
  return applyUnaryOperator(node, evalNode(node.operand, state))
}

function evalBinary(node: JSBinaryNode, state: EvalState): unknown {
  return applyBinaryOperator(node, evalNode(node.left, state), evalNode(node.right, state))
}

function evalLogical(node: JSLogicalNode, state: EvalState): unknown {
  return evaluateLogicalOperator(node, evalNode(node.left, state), () =>
    evalNode(node.right, state),
  )
}

function evalMember(node: JSMemberNode, state: EvalState): unknown {
  const obj = evalNode(node.object, state)

  if (node.optional && obj == null) return undefined
  if (obj == null)
    throw new JSEvalError(`Cannot read properties of ${obj === null ? 'null' : 'undefined'}`, node)

  const key = node.computed
    ? String(evalNode(node.property, state))
    : (node.property as JSIdentifierNode).name

  assertPropertyAllowed(key, node)
  return (obj as any)[key]
}

function evalCall(node: JSCallNode, state: EvalState): unknown {
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

    assertPropertyAllowed(key, node, 'method')
    thisVal = obj
    fn = (obj as any)[key]
  } else {
    fn = evalNode(node.callee, state)
  }

  if (node.optional && fn == null) return undefined
  if (typeof fn !== 'function') {
    throw new JSEvalError(
      `'${node.callee.type === 'identifier' ? (node.callee as JSIdentifierNode).name : 'value'}' is not a function`,
      node,
    )
  }

  const callable = fn as JSCallable
  ensureCallAllowed('call', callable, thisVal, node, state)

  switch (node.args.length) {
    case 0:
      return safeCall0(callable, thisVal, node, state)
    case 1:
      if (node.args[0].type !== 'spread') {
        return safeCall1(callable, thisVal, evalNode(node.args[0], state), node, state)
      }
      break
    case 2:
      if (node.args[0].type !== 'spread' && node.args[1].type !== 'spread') {
        return safeCall2(
          callable,
          thisVal,
          evalNode(node.args[0], state),
          evalNode(node.args[1], state),
          node,
          state,
        )
      }
      break
    case 3:
      if (
        node.args[0].type !== 'spread' &&
        node.args[1].type !== 'spread' &&
        node.args[2].type !== 'spread'
      ) {
        return safeCall3(
          callable,
          thisVal,
          evalNode(node.args[0], state),
          evalNode(node.args[1], state),
          evalNode(node.args[2], state),
          node,
          state,
        )
      }
      break
    case 4:
      if (
        node.args[0].type !== 'spread' &&
        node.args[1].type !== 'spread' &&
        node.args[2].type !== 'spread' &&
        node.args[3].type !== 'spread'
      ) {
        return safeCall4(
          callable,
          thisVal,
          evalNode(node.args[0], state),
          evalNode(node.args[1], state),
          evalNode(node.args[2], state),
          evalNode(node.args[3], state),
          node,
          state,
        )
      }
      break
  }

  return safeCall(callable, thisVal, evalArgs(node.args, state), node, state)
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
    if (arg.type === 'spread') {
      appendIterableValues(result, evalNode(arg.argument, state), arg, state)
    } else {
      result.push(evalNode(arg, state))
    }
  }
  return result
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

        assertPropertyAllowed(key, node.tag)
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

  let result = ''
  for (let index = 0; index < node.quasis.length; index += 1) {
    result += node.quasis[index].cooked ?? node.quasis[index].raw
    if (index < node.expressions.length) result += String(evalNode(node.expressions[index], state))
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
