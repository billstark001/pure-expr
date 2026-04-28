import type { JSToken } from '../lexer.js'

/** Parser feature flags for the expression grammar. */
export interface JSParserOptions {
  allowAwait?: boolean
  allowArrowFunctions?: boolean
  allowIn?: boolean
  allowRegexLiterals?: boolean
  allowTemplateLiterals?: boolean
  allowTaggedTemplates?: boolean
  maxSourceLength?: number
  maxAstNodes?: number
  maxAstDepth?: number
  maxArrayElements?: number
  maxObjectProperties?: number
  maxCallArguments?: number
  maxTemplateExpressions?: number
}

/** Error raised while parsing tokens into an expression AST. */
export class JSParseError extends Error {
  start?: number
  end?: number
  token?: JSToken

  constructor(message: string, token?: JSToken, src = '') {
    const pos = token?.start !== undefined ? ` at position ${token.start}–${token.end}` : ''
    let snippet = ''

    if (src && token?.start !== undefined) {
      const lo = Math.max(0, token.start - 20)
      const hi = Math.min(src.length, (token.end ?? token.start) + 20)
      const line = src.slice(lo, hi)
      const ptr =
        ' '.repeat(token.start - lo) +
        '~'.repeat(Math.max(1, (token.end ?? token.start + 1) - token.start))
      snippet = `\n  ${line}\n  ${ptr}`
    }

    super(message + pos + snippet)
    this.name = 'JSParseError'
    this.start = token?.start
    this.end = token?.end
    this.token = token
  }
}
