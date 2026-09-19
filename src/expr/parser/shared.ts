import { cookTemplate } from '../lexer/template.js'
import type { JSToken } from '../lexer/types.js'
import type { ExpressionNode } from './node-types.js'

export function parseStringValue(raw: string): string {
  return cookTemplate(raw.slice(1, -1)) ?? raw.slice(1, -1)
}

export function propertyKeyFromToken(token: JSToken): ExpressionNode {
  const offsets = { start: token.start, end: token.end }
  if (token.kind === 'string') {
    return { type: 'Literal', value: parseStringValue(token.value), raw: token.value, ...offsets }
  }
  if (token.kind === 'number') {
    return {
      type: 'Literal',
      value: Number(token.value.replace(/_/g, '')),
      raw: token.value,
      ...offsets,
    }
  }
  if (token.kind === 'bigint') {
    const rawValue = token.value.replace(/_/g, '').slice(0, -1)
    const value = BigInt(rawValue)
    return { type: 'Literal', value, bigint: value.toString(), raw: token.value, ...offsets }
  }
  if (token.kind === 'boolean') {
    return { type: 'Literal', value: token.value === 'true', raw: token.value, ...offsets }
  }
  if (token.kind === 'null') {
    return { type: 'Literal', value: null, raw: token.value, ...offsets }
  }
  return { type: 'Identifier', name: token.value, ...offsets }
}
