import type {
  ArrowFunctionExpression,
  AssignmentExpression,
  BinaryExpression,
  CallExpression,
  ChainExpression,
  ExpressionNode,
  Identifier,
  LogicalExpression,
  MemberExpression,
  SpreadElement,
  TaggedTemplateExpression,
  TemplateLiteral,
  UnaryExpression,
  UpdateExpression,
} from '../node-types.js'
import {
  bindArrowParameters,
  bindCompiledArrowParameters,
  collectArrowBoundNames,
  createPureExprArrowFunction,
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
import { createCompileRuntime } from './compile.js'
import {
  copySpreadProperties,
  createChildScope,
  createNullPrototypeRecord,
  createObjectLiteralResult,
  getObjectLiteralMode,
} from './context.js'
import {
  applyAssignmentOperator,
  applyBinaryOperator,
  applyUnaryOperator,
  applyUpdateOperator,
  assertMemberWriteAllowed,
  assertPropertyAllowed,
  assertWritableMemberReference,
  assignIdentifier,
  compileDirectLocalIdentifier,
  evaluateLogicalOperator,
  isAssignmentShortCircuited,
  readProperty,
  resolveDirectLocalIdentifier,
  resolveIdentifier,
  writeProperty,
} from './operations.js'
import { BLOCKED_PROPS } from './security.js'
import {
  consumeStep,
  createDirectLocalEvalState,
  createScopedEvalState,
  ensureEvalScope,
} from './state.js'
import { getTaggedTemplateObject } from './templates.js'
import {
  type EvalState,
  type EvaluationScope,
  type JSCallable,
  JSEvalError,
  UNINITIALIZED_ARROW_PARAM,
} from './types.js'

const CHAIN_SHORT_CIRCUIT = Symbol('pure-expr.chain-short-circuit')

export function evalNode(node: ExpressionNode, state: EvalState): unknown {
  if (node.type !== 'ChainExpression') consumeStep(state, node)

  switch (node.type) {
    case 'Literal':
      if ('regex' in node) {
        if (state.opts.allowRegexLiterals === false) {
          throw new JSEvalError('Regular expression literals are not enabled', node)
        }
        return new RegExp(node.regex.pattern, node.regex.flags)
      }
      return node.value

    case 'Identifier':
      return resolveIdentifier(node, state)

    case 'TopicReference':
      if (state.topics.length === 0) {
        throw new JSEvalError("Topic reference '%' is only available inside a pipeline body", node)
      }
      return state.topics[state.topics.length - 1]

    case 'ArrowFunctionExpression':
      return evalArrowFunction(node, state)
    case 'AssignmentExpression':
      return evalAssignment(node, state)
    case 'UpdateExpression':
      return evalUpdate(node, state)
    case 'UnaryExpression':
      return evalUnary(node, state)
    case 'AwaitExpression':
      return evalNode(node.argument, state)
    case 'BinaryExpression':
      return evalBinary(node, state)
    case 'LogicalExpression':
      return evalLogical(node, state)
    case 'ConditionalExpression':
      return evalNode(node.test, state)
        ? evalNode(node.consequent, state)
        : evalNode(node.alternate, state)

    case 'MemberExpression':
      return evalMember(node, state)
    case 'CallExpression':
      return evalCall(node, state)
    case 'ChainExpression':
      return evalChain(node, state)

    case 'ArrayExpression': {
      const result: unknown[] = []
      for (const element of node.elements) {
        consumeStep(state, node)
        if (element === null) result.push(undefined)
        else if (element.type === 'SpreadElement') {
          appendIterableValues(result, evalNode(element.argument, state), element, state)
        } else {
          result.push(evalNode(element, state))
        }
      }
      return result
    }

    case 'ObjectExpression': {
      const result = createObjectLiteralResult(getObjectLiteralMode(state.opts))
      for (const property of node.properties) {
        if (property.type === 'SpreadElement') {
          copySpreadProperties(result, evalNode(property.argument, state), node, state)
        } else {
          consumeStep(state, node)
          const key = property.computed
            ? String(evalNode(property.key, state))
            : property.key.type === 'Identifier'
              ? property.key.name
              : String(evalNode(property.key, state))
          if (BLOCKED_PROPS.has(key)) {
            throw new JSEvalError(`Property '${key}' is not accessible`, node)
          }
          result[key] = evalNode(property.value, state)
        }
      }
      return result
    }

    case 'TemplateLiteral':
      return evalTemplateLiteral(node, state)
    case 'TaggedTemplateExpression':
      return evalTaggedTemplate(node, state)
    case 'SpreadElement':
      throw new JSEvalError('Unexpected spread expression outside of array/call/object', node)

    case 'SequenceExpression': {
      let last: unknown
      for (const expression of node.expressions) last = evalNode(expression, state)
      return last
    }

    case 'PipelineExpression': {
      const value = evalNode(node.left, state)
      state.topics.push(value)
      try {
        return evalNode(node.right, state)
      } finally {
        state.topics.pop()
      }
    }
  }
}

export function evalArrowFunction(node: ArrowFunctionExpression, state: EvalState): unknown {
  return state.opts.functionMode === 'performance'
    ? evalArrowFunctionPerformance(node, state)
    : evalArrowFunctionDefault(node, state)
}

function evalArrowFunctionDefault(node: ArrowFunctionExpression, state: EvalState): unknown {
  const capturedScope = ensureEvalScope(state)
  const capturedTopics = state.topics.slice()
  const capturedOpts = state.opts
  const capturedBudget = state.budget ?? state
  const expectedArgumentCount = getArrowExpectedArgumentCount(node.params)
  const deferScope = canDeferArrowScope(capturedScope)

  return createPureExprArrowFunction((...args: unknown[]) => {
    const names = collectArrowBoundNames(node.params)
    if (deferScope) {
      const locals = createArrowLocals(names)
      const callState = createDirectLocalEvalState(
        locals,
        capturedScope.environment,
        capturedOpts,
        capturedBudget,
      )
      callState.topics = capturedTopics.slice()
      bindArrowParameters(node.params, args, callState, evalNode)
      return evalNode(node.body, callState)
    }
    const localScope = createChildScope(capturedScope, names, UNINITIALIZED_ARROW_PARAM)
    const callState = createScopedEvalState(localScope, capturedOpts, capturedBudget)
    callState.topics = capturedTopics.slice()
    bindArrowParameters(node.params, args, callState, evalNode)
    return evalNode(node.body, callState)
  }, expectedArgumentCount)
}

function evalArrowFunctionPerformance(node: ArrowFunctionExpression, state: EvalState): unknown {
  const runtime = getCompiledArrowRuntime(node)
  const capturedScope = ensureEvalScope(state)
  const capturedTopics = state.topics.slice()
  const capturedOpts = state.opts
  const capturedBudget = state.budget ?? state
  const deferScope = canDeferArrowScope(capturedScope)
  const deferredBody = deferScope ? getDirectLocalArrowBody(node) : undefined

  return createPureExprArrowFunction((...args: unknown[]) => {
    if (deferScope) {
      const locals = createArrowLocals(runtime.boundNames)
      const callState = createDirectLocalEvalState(
        locals,
        capturedScope.environment,
        capturedOpts,
        capturedBudget,
      )
      callState.topics = capturedTopics.slice()
      bindCompiledArrowParameters(runtime.params, args, callState)
      return deferredBody!(callState)
    }
    const localScope = createChildScope(
      capturedScope,
      runtime.boundNames,
      UNINITIALIZED_ARROW_PARAM,
    )
    const callState = createScopedEvalState(localScope, capturedOpts, capturedBudget)
    callState.topics = capturedTopics.slice()
    bindCompiledArrowParameters(runtime.params, args, callState)
    return runtime.body(callState)
  }, runtime.expectedArgumentCount)
}

function canDeferArrowScope(scope: EvaluationScope): boolean {
  return !scope.parent && !scope.hasLocalBindings && !!scope.environment.directContext
}

function createArrowLocals(names: readonly string[]): Record<string, unknown> {
  const locals = createNullPrototypeRecord()
  for (const name of names) locals[name] = UNINITIALIZED_ARROW_PARAM
  return locals
}

const { getCompiledArrowRuntime } = createCompileRuntime({ evalArrowFunction })
const directLocalArrowBodyCache = new WeakMap<
  ArrowFunctionExpression,
  (state: EvalState) => unknown
>()

function getDirectLocalArrowBody(node: ArrowFunctionExpression): (state: EvalState) => unknown {
  let body = directLocalArrowBodyCache.get(node)
  if (!body) {
    const boundNames = new Set(collectArrowBoundNames(node.params))
    body = createCompileRuntime({
      evalArrowFunction,
      compileIdentifier: (identifier) => compileDirectLocalIdentifier(identifier, boundNames),
      resolveIdentifier: resolveDirectLocalIdentifier,
    }).compileNode(node.body)
    directLocalArrowBodyCache.set(node, body)
  }
  return body
}

function evalUnary(node: UnaryExpression, state: EvalState): unknown {
  if (node.operator === 'typeof') {
    try {
      return typeof evalNode(node.argument, state)
    } catch (error) {
      if (error instanceof JSEvalError && node.argument.type === 'Identifier') return 'undefined'
      throw error
    }
  }
  return applyUnaryOperator(node, evalNode(node.argument, state))
}

function evalAssignment(node: AssignmentExpression, state: EvalState): unknown {
  if (node.left.type === 'Identifier') {
    const current = node.operator === '=' ? undefined : resolveIdentifier(node.left, state)
    if (isAssignmentShortCircuited(node.operator, current)) return current
    const right = evalNode(node.right, state)
    const value = applyAssignmentOperator(node.operator, current, right)
    return assignIdentifier(node.left, value, state)
  }

  assertMemberWriteAllowed(node.left, state)
  const { target, key } = evalMemberReference(node.left, state)
  const current = node.operator === '=' ? undefined : readProperty(target, key, node.left, state)
  if (isAssignmentShortCircuited(node.operator, current)) return current
  const right = evalNode(node.right, state)
  const value = applyAssignmentOperator(node.operator, current, right)
  return writeProperty(target, key, value, node.left)
}

function evalUpdate(node: UpdateExpression, state: EvalState): number | bigint {
  if (node.argument.type === 'Identifier') {
    const change = applyUpdateOperator(node, resolveIdentifier(node.argument, state))
    assignIdentifier(node.argument, change.updated, state)
    return change.result
  }

  assertMemberWriteAllowed(node.argument, state)
  const { target, key } = evalMemberReference(node.argument, state)
  const change = applyUpdateOperator(node, readProperty(target, key, node.argument, state))
  writeProperty(target, key, change.updated, node.argument)
  return change.result
}

function evalBinary(node: BinaryExpression, state: EvalState): unknown {
  return applyBinaryOperator(node, evalNode(node.left, state), evalNode(node.right, state))
}

function evalLogical(node: LogicalExpression, state: EvalState): unknown {
  return evaluateLogicalOperator(node, evalNode(node.left, state), () =>
    evalNode(node.right, state),
  )
}

function memberKey(node: MemberExpression, state: EvalState): string {
  return node.computed ? String(evalNode(node.property, state)) : (node.property as Identifier).name
}

function evalMemberReference(
  node: MemberExpression,
  state: EvalState,
): { readonly target: unknown; readonly key: string } {
  const target = evalNode(node.object, state)
  const key = memberKey(node, state)
  assertWritableMemberReference(node, target)
  assertPropertyAllowed(key, node)
  return { target, key }
}

function evalMember(node: MemberExpression, state: EvalState): unknown {
  const target = evalNode(node.object, state)
  if (node.optional && target == null) return undefined
  if (target == null) {
    throw new JSEvalError(
      `Cannot read properties of ${target === null ? 'null' : 'undefined'}`,
      node,
    )
  }
  return readProperty(target, memberKey(node, state), node, state)
}

function evalCall(node: CallExpression, state: EvalState): unknown {
  let thisValue: unknown
  let fn: unknown

  if (node.callee.type === 'MemberExpression') {
    const member = node.callee
    const target = evalNode(member.object, state)
    if (member.optional && target == null) return undefined
    if (target == null) throw new JSEvalError('Cannot call method on null/undefined', node)
    thisValue = target
    fn = readProperty(target, memberKey(member, state), node, state, 'method')
  } else {
    fn = evalNode(node.callee, state)
  }

  if (node.optional && fn == null) return undefined
  if (typeof fn !== 'function') {
    throw new JSEvalError(
      `'${node.callee.type === 'Identifier' ? node.callee.name : 'value'}' is not a function`,
      node,
    )
  }

  const callable = fn as JSCallable
  ensureCallAllowed('call', callable, thisValue, node, state)
  const args = node.arguments
  switch (args.length) {
    case 0:
      return safeCall0(callable, thisValue, node, state)
    case 1:
      if (args[0].type !== 'SpreadElement') {
        return safeCall1(callable, thisValue, evalNode(args[0], state), node, state)
      }
      break
    case 2:
      if (args[0].type !== 'SpreadElement' && args[1].type !== 'SpreadElement') {
        return safeCall2(
          callable,
          thisValue,
          evalNode(args[0], state),
          evalNode(args[1], state),
          node,
          state,
        )
      }
      break
    case 3:
      if (args.every((argument) => argument.type !== 'SpreadElement')) {
        return safeCall3(
          callable,
          thisValue,
          evalNode(args[0], state),
          evalNode(args[1], state),
          evalNode(args[2], state),
          node,
          state,
        )
      }
      break
    case 4:
      if (args.every((argument) => argument.type !== 'SpreadElement')) {
        return safeCall4(
          callable,
          thisValue,
          evalNode(args[0], state),
          evalNode(args[1], state),
          evalNode(args[2], state),
          evalNode(args[3], state),
          node,
          state,
        )
      }
      break
  }

  return safeCall(callable, thisValue, evalArgs(args, state), node, state)
}

function evalChain(node: ChainExpression, state: EvalState): unknown {
  const value = evalChainElement(node.expression, state)
  return value === CHAIN_SHORT_CIRCUIT ? undefined : value
}

function evalChainChild(
  node: ExpressionNode,
  state: EvalState,
): unknown | typeof CHAIN_SHORT_CIRCUIT {
  return node.type === 'MemberExpression' || node.type === 'CallExpression'
    ? evalChainElement(node, state)
    : evalNode(node, state)
}

function evalChainElement(
  node: MemberExpression | CallExpression,
  state: EvalState,
): unknown | typeof CHAIN_SHORT_CIRCUIT {
  consumeStep(state, node)

  if (node.type === 'MemberExpression') {
    const target = evalChainChild(node.object, state)
    if (target === CHAIN_SHORT_CIRCUIT) return target
    if (node.optional && target == null) return CHAIN_SHORT_CIRCUIT
    if (target == null) {
      throw new JSEvalError(
        `Cannot read properties of ${target === null ? 'null' : 'undefined'}`,
        node,
      )
    }
    return readProperty(target, memberKey(node, state), node, state)
  }

  let thisValue: unknown
  let fn: unknown
  if (node.callee.type === 'MemberExpression') {
    const member = node.callee
    const target = evalChainChild(member.object, state)
    if (target === CHAIN_SHORT_CIRCUIT) return target
    if (member.optional && target == null) return CHAIN_SHORT_CIRCUIT
    if (target == null) throw new JSEvalError('Cannot call method on null/undefined', node)
    thisValue = target
    fn = readProperty(target, memberKey(member, state), node, state, 'method')
  } else {
    fn = evalChainChild(node.callee, state)
    if (fn === CHAIN_SHORT_CIRCUIT) return fn
  }

  if (node.optional && fn == null) return CHAIN_SHORT_CIRCUIT
  return invokeCallable(fn, thisValue, node.arguments, node, state)
}

function invokeCallable(
  fn: unknown,
  thisValue: unknown,
  args: Array<ExpressionNode | SpreadElement>,
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
      if (args[0].type !== 'SpreadElement') {
        return safeCall1(callable, thisValue, evalNode(args[0], state), node, state)
      }
      break
    case 2:
      if (args[0].type !== 'SpreadElement' && args[1].type !== 'SpreadElement') {
        return safeCall2(
          callable,
          thisValue,
          evalNode(args[0], state),
          evalNode(args[1], state),
          node,
          state,
        )
      }
      break
    case 3:
      if (args.every((argument) => argument.type !== 'SpreadElement')) {
        return safeCall3(
          callable,
          thisValue,
          evalNode(args[0], state),
          evalNode(args[1], state),
          evalNode(args[2], state),
          node,
          state,
        )
      }
      break
    case 4:
      if (args.every((argument) => argument.type !== 'SpreadElement')) {
        return safeCall4(
          callable,
          thisValue,
          evalNode(args[0], state),
          evalNode(args[1], state),
          evalNode(args[2], state),
          evalNode(args[3], state),
          node,
          state,
        )
      }
      break
  }

  return safeCall(callable, thisValue, evalArgs(args, state), node, state)
}

function evalArgs(args: Array<ExpressionNode | SpreadElement>, state: EvalState): unknown[] {
  if (args.every((argument) => argument.type !== 'SpreadElement')) {
    return args.map((argument) => evalNode(argument, state))
  }

  const result: unknown[] = []
  for (const argument of args) {
    if (argument.type === 'SpreadElement') {
      appendIterableValues(result, evalNode(argument.argument, state), argument, state)
    } else {
      result.push(evalNode(argument, state))
    }
  }
  return result
}

function evalTaggedTemplate(node: TaggedTemplateExpression, state: EvalState): unknown {
  let thisValue: unknown
  let tag: unknown

  if (node.tag.type === 'MemberExpression') {
    const target = evalNode(node.tag.object, state)
    if (target == null) {
      throw new JSEvalError(
        `Cannot read properties of ${target === null ? 'null' : 'undefined'}`,
        node.tag,
      )
    }
    thisValue = target
    tag = readProperty(target, memberKey(node.tag, state), node.tag, state, 'method')
  } else {
    tag = evalNode(node.tag, state)
  }

  if (typeof tag !== 'function') throw new JSEvalError('Template tag must be a function', node)

  const callableTag = tag as JSCallable
  ensureCallAllowed('tagged-template', callableTag, thisValue, node, state)
  const templateObject = getTaggedTemplateObject(
    node.quasi,
    state.opts.taggedTemplateArrayMode ?? 'spec',
  )
  const args = new Array<unknown>(node.quasi.expressions.length + 1)
  args[0] = templateObject
  for (let index = 0; index < node.quasi.expressions.length; index += 1) {
    args[index + 1] = evalNode(node.quasi.expressions[index], state)
  }
  return safeCall(callableTag, thisValue, args, node, state)
}

function evalTemplateLiteral(node: TemplateLiteral, state: EvalState): string {
  let result = ''
  for (let index = 0; index < node.quasis.length; index += 1) {
    result += node.quasis[index].value.cooked ?? node.quasis[index].value.raw
    if (index < node.expressions.length) result += String(evalNode(node.expressions[index], state))
  }
  return result
}
