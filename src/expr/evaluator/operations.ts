import type {
  AstNode,
  BinaryExpression,
  Identifier,
  LogicalExpression,
  UnaryExpression,
} from '../node-types.js'
import { isLogicalAssignmentOperator, type SupportedAssignmentOperator } from '../operators.js'
import { assignScopeBinding, resolveScopeBinding } from './context.js'
import { BLOCKED_GLOBALS, BLOCKED_PROPS } from './security.js'
import { ensureEvalScope } from './state.js'
import {
  type EvalState,
  JSEvalError,
  type PropertyAccessPolicy,
  UNINITIALIZED_ARROW_PARAM,
} from './types.js'

export function resolveIdentifier(node: Identifier, state: EvalState): unknown {
  if (state.directContext) return resolveDirectIdentifier(node, state)
  if (node.name === 'undefined') return undefined
  if (BLOCKED_GLOBALS.has(node.name)) {
    throw new JSEvalError(`Access to '${node.name}' is not permitted`, node)
  }
  let value: unknown
  if (state.directLocals) {
    if (Object.prototype.hasOwnProperty.call(state.directLocals, node.name)) {
      value = state.directLocals[node.name]
    } else {
      const context = state.directRootContext!
      if (!Object.prototype.hasOwnProperty.call(context, node.name)) {
        throw new JSEvalError(`'${node.name}' is not defined`, node)
      }
      value = context[node.name]
    }
  } else {
    const scope = state.scope!
    if (Object.prototype.hasOwnProperty.call(scope.locals, node.name)) {
      value = scope.locals[node.name]
    } else if (!scope.parent && scope.environment.directContext) {
      const context = scope.environment.directContext
      if (!Object.prototype.hasOwnProperty.call(context, node.name)) {
        throw new JSEvalError(`'${node.name}' is not defined`, node)
      }
      value = context[node.name]
    } else {
      value = resolveScopeBinding(scope, node.name)
    }
  }
  if (value === UNINITIALIZED_ARROW_PARAM) {
    throw new JSEvalError(`Cannot access '${node.name}' before initialization`, node)
  }
  return value
}

export function resolveDirectIdentifier(node: Identifier, state: EvalState): unknown {
  if (node.name === 'undefined') return undefined
  if (BLOCKED_GLOBALS.has(node.name)) {
    throw new JSEvalError(`Access to '${node.name}' is not permitted`, node)
  }
  const context = state.directContext!
  if (!Object.prototype.hasOwnProperty.call(context, node.name)) {
    throw new JSEvalError(`'${node.name}' is not defined`, node)
  }
  const value = context[node.name]
  if (value === UNINITIALIZED_ARROW_PARAM) {
    throw new JSEvalError(`Cannot access '${node.name}' before initialization`, node)
  }
  return value
}

export function resolveDirectLocalIdentifier(node: Identifier, state: EvalState): unknown {
  if (node.name === 'undefined') return undefined
  if (BLOCKED_GLOBALS.has(node.name)) {
    throw new JSEvalError(`Access to '${node.name}' is not permitted`, node)
  }
  let value: unknown
  if (Object.prototype.hasOwnProperty.call(state.directLocals!, node.name)) {
    value = state.directLocals![node.name]
  } else {
    const context = state.directRootContext!
    if (!Object.prototype.hasOwnProperty.call(context, node.name)) {
      throw new JSEvalError(`'${node.name}' is not defined`, node)
    }
    value = context[node.name]
  }
  if (value === UNINITIALIZED_ARROW_PARAM) {
    throw new JSEvalError(`Cannot access '${node.name}' before initialization`, node)
  }
  return value
}

export function compileDirectLocalIdentifier(
  node: Identifier,
  boundNames: ReadonlySet<string>,
): (state: EvalState) => unknown {
  const { name } = node
  if (name === 'undefined') return () => undefined
  if (BLOCKED_GLOBALS.has(name)) {
    return () => {
      throw new JSEvalError(`Access to '${name}' is not permitted`, node)
    }
  }
  if (boundNames.has(name)) {
    return (state) => {
      const value = state.directLocals![name]
      if (value === UNINITIALIZED_ARROW_PARAM) {
        throw new JSEvalError(`Cannot access '${name}' before initialization`, node)
      }
      return value
    }
  }
  return (state) => {
    const context = state.directRootContext!
    if (!Object.prototype.hasOwnProperty.call(context, name)) {
      throw new JSEvalError(`'${name}' is not defined`, node)
    }
    return context[name]
  }
}

export function assignIdentifier(name: string, value: unknown, state: EvalState): unknown {
  if (name === 'undefined' || BLOCKED_GLOBALS.has(name)) {
    throw new JSEvalError(`Access to '${name}' is not permitted`)
  }
  return assignScopeBinding(ensureEvalScope(state), name, value)
}

export function isAssignmentShortCircuited(
  operator: SupportedAssignmentOperator,
  current: unknown,
): boolean {
  if (!isLogicalAssignmentOperator(operator)) return false
  switch (operator) {
    case '&&=':
      return !current
    case '||=':
      return !!current
    case '??=':
      return current !== null && current !== undefined
    default:
      return assertUnknownOperator('assignment', operator)
  }
}

export function applyAssignmentOperator(
  operator: SupportedAssignmentOperator,
  left: unknown,
  right: unknown,
): unknown {
  switch (operator) {
    case '=':
      return right
    case '+=':
      return (left as any) + (right as any)
    case '-=':
      return (left as any) - (right as any)
    case '*=':
      return (left as any) * (right as any)
    case '/=':
      return (left as any) / (right as any)
    case '%=':
      return (left as any) % (right as any)
    case '**=':
      return (left as any) ** (right as any)
    case '&=':
      return (left as any) & (right as any)
    case '|=':
      return (left as any) | (right as any)
    case '^=':
      return (left as any) ^ (right as any)
    case '<<=':
      return (left as any) << (right as any)
    case '>>=':
      return (left as any) >> (right as any)
    case '>>>=':
      return (left as any) >>> (right as any)
    case '&&=':
    case '||=':
    case '??=':
      return right
    default:
      return assertUnknownOperator('assignment', operator)
  }
}

export function assertPropertyAllowed(
  key: string,
  node: AstNode,
  kind: 'property' | 'method' = 'property',
): void {
  if (BLOCKED_PROPS.has(key)) {
    throw new JSEvalError(`Access to ${kind} '${key}' is not permitted`, node)
  }
}

/** JavaScript-compatible property access, including inherited properties. */
export const inheritedPropertyAccess: PropertyAccessPolicy = ({ target, key }) =>
  (Object(target) as Record<string, unknown>)[key]

/** Property access policy that rejects inherited properties. */
export const ownPropertyAccess: PropertyAccessPolicy = ({ target, key, kind, node }) => {
  const boxed = Object(target)
  if (!Object.prototype.hasOwnProperty.call(boxed, key)) {
    throw new JSEvalError(
      `${kind === 'method' ? 'Method' : 'Property'} '${key}' is not an own property`,
      node,
    )
  }
  return (boxed as Record<string, unknown>)[key]
}

export function readProperty(
  target: unknown,
  key: string,
  node: AstNode,
  state: EvalState,
  kind: 'property' | 'method' = 'property',
): unknown {
  assertPropertyAllowed(key, node, kind)
  const policy = state.opts.propertyAccess
  return policy
    ? policy({ target, key, kind, node })
    : (Object(target) as Record<string, unknown>)[key]
}

export function applyUnaryOperator(node: UnaryExpression, value: unknown): unknown {
  switch (node.operator) {
    case '!':
      return !value
    case '~':
      return ~(value as any)
    case '+':
      return +(value as any)
    case '-':
      return -(value as any)
    case 'typeof':
      return typeof value
    case 'void':
      return undefined
    default:
      return assertUnknownOperator('unary', node.operator, node)
  }
}

export function applyBinaryOperator(
  node: BinaryExpression,
  left: unknown,
  right: unknown,
): unknown {
  switch (node.operator) {
    case '+':
      return (left as any) + (right as any)
    case '-':
      return (left as any) - (right as any)
    case '*':
      return (left as any) * (right as any)
    case '/':
      return (left as any) / (right as any)
    case '%':
      return (left as any) % (right as any)
    case '**':
      return (left as any) ** (right as any)
    case '&':
      return (left as any) & (right as any)
    case '|':
      return (left as any) | (right as any)
    case '^':
      return (left as any) ^ (right as any)
    case '<<':
      return (left as any) << (right as any)
    case '>>':
      return (left as any) >> (right as any)
    case '>>>':
      return (left as any) >>> (right as any)
    case '==':
      // biome-ignore lint/suspicious/noDoubleEquals: The evaluator intentionally preserves JS loose equality semantics.
      return left == right
    case '!=':
      // biome-ignore lint/suspicious/noDoubleEquals: The evaluator intentionally preserves JS loose inequality semantics.
      return left != right
    case '===':
      return left === right
    case '!==':
      return left !== right
    case '<':
      return (left as any) < (right as any)
    case '>':
      return (left as any) > (right as any)
    case '<=':
      return (left as any) <= (right as any)
    case '>=':
      return (left as any) >= (right as any)
    case 'instanceof':
      return (left as any) instanceof (right as any)
    case 'in':
      return (left as any) in (right as any)
    default:
      return assertUnknownOperator('binary', node.operator, node)
  }
}

export function evaluateLogicalOperator(
  node: LogicalExpression,
  left: unknown,
  evaluateRight: () => unknown,
): unknown {
  switch (node.operator) {
    case '&&':
      return left ? evaluateRight() : left
    case '||':
      return left ? left : evaluateRight()
    case '??':
      return left != null ? left : evaluateRight()
    default:
      return assertUnknownOperator('logical', node.operator, node)
  }
}

function assertUnknownOperator(kind: string, operator: never, node?: AstNode): never {
  throw new JSEvalError(`Unknown ${kind} operator '${String(operator)}'`, node)
}
