import type {
  BindingPattern as PublicBindingPattern,
  ExpressionNode as PublicExpressionNode,
} from '../node-types.js'
import type { JSLocationOptions, JSParserOptions } from './errors.js'
import type { BindingPattern, ExpressionNode } from './node-types.js'

export function finalizeAst(
  ast: ExpressionNode,
  source: string,
  locations: JSParserOptions['locations'],
): PublicExpressionNode
export function finalizeAst(
  ast: BindingPattern,
  source: string,
  locations: JSParserOptions['locations'],
): PublicBindingPattern
export function finalizeAst(
  ast: ExpressionNode | BindingPattern,
  source: string,
  locations: JSParserOptions['locations'],
): PublicExpressionNode | PublicBindingPattern {
  const locationResolver = locations ? createLocationResolver(source, locations) : undefined

  const visit = (node: ExpressionNode | BindingPattern): Record<string, unknown> => {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end') continue
      if (Array.isArray(value)) {
        result[key] = value.map((item) => (isInternalNode(item) ? visit(item) : item))
      } else {
        result[key] = isInternalNode(value) ? visit(value) : value
      }
    }
    if (locationResolver) result.loc = locationResolver(node.start, node.end)
    return result
  }

  return visit(ast) as unknown as PublicExpressionNode | PublicBindingPattern
}

function isInternalNode(value: unknown): value is ExpressionNode | BindingPattern {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    typeof (value as { start?: unknown }).start === 'number' &&
    typeof (value as { end?: unknown }).end === 'number'
  )
}

function createLocationResolver(source: string, options: true | JSLocationOptions) {
  const startLine = options === true ? 1 : (options.startLine ?? 1)
  const startColumn = options === true ? 0 : (options.startColumn ?? 0)
  const sourceName = options === true ? undefined : options.source
  if (!Number.isInteger(startLine) || startLine < 1) {
    throw new TypeError('locations.startLine must be an integer greater than or equal to 1')
  }
  if (!Number.isInteger(startColumn) || startColumn < 0) {
    throw new TypeError('locations.startColumn must be a non-negative integer')
  }
  const lineStarts = [0]

  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index)
    if (code === 13 && source.charCodeAt(index + 1) === 10) index += 1
    if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) {
      lineStarts.push(index + 1)
    }
  }

  const positionAt = (offset: number) => {
    let low = 0
    let high = lineStarts.length
    while (low + 1 < high) {
      const middle = (low + high) >>> 1
      if (lineStarts[middle] <= offset) low = middle
      else high = middle
    }
    return {
      line: startLine + low,
      column: offset - lineStarts[low] + (low === 0 ? startColumn : 0),
    }
  }

  return (start: number, end: number) => ({
    ...(sourceName !== undefined ? { source: sourceName } : {}),
    start: positionAt(start),
    end: positionAt(end),
  })
}
