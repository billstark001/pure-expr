import type {
  JSBinaryNode,
  JSExprNode,
  JSIdentifierNode,
  JSLogicalNode,
  JSUnaryNode,
} from '../node-types.js'
import { BLOCKED_GLOBALS, BLOCKED_PROPS } from './security.js'
import { JSEvalError, UNINITIALIZED_ARROW_PARAM, type EvalState } from './types.js'

export function resolveIdentifier(node: JSIdentifierNode, state: EvalState): unknown {
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
}

export function assertPropertyAllowed(
  key: string,
  node: JSExprNode,
  kind: 'property' | 'method' = 'property',
): void {
  if (BLOCKED_PROPS.has(key)) {
    throw new JSEvalError(`Access to ${kind} '${key}' is not permitted`, node)
  }
}

export function applyUnaryOperator(node: JSUnaryNode, value: unknown): unknown {
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
    default:
      throw new JSEvalError(`Unknown unary operator '${node.operator}'`, node)
  }
}

export function applyBinaryOperator(node: JSBinaryNode, left: unknown, right: unknown): unknown {
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
      throw new JSEvalError(`Unknown binary operator '${node.operator}'`, node)
  }
}

export function evaluateLogicalOperator(
  node: JSLogicalNode,
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
  }
}
