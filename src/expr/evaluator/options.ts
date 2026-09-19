import type { JSParserOptions } from '../parser/errors.js'
import type { JSEvalOptions } from './types.js'

export interface EvalOptions extends JSParserOptions, JSEvalOptions {}

/** Enable assignment syntax automatically whenever evaluation writes are enabled. */
export function parserOptionsForEvaluation(options: EvalOptions): EvalOptions {
  if (options.allowAssignments !== undefined || !options.writes || options.writes === 'deny') {
    return options
  }
  return { ...options, allowAssignments: true }
}
