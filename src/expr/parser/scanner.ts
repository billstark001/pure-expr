import { JSLexer } from '../lexer/lexer.js'
import { JSLexError, type JSToken } from '../lexer/types.js'
import { JSParseError, type JSParserOptions } from './errors.js'

export type JSScanProfile = 'expression' | 'interpolation'
export type JSIncompleteBehavior = 'error' | 'rollback'
export type JSScanStopReason = 'boundary' | 'end' | 'incomplete' | 'syntax'

export interface JSScanBoundaryContext {
  readonly source: string
  readonly start: number
  readonly token: JSToken
  readonly previousToken?: JSToken
  readonly depth: number
}

export type JSScanBoundary = (context: JSScanBoundaryContext) => boolean

export interface JSScanOptions extends JSParserOptions {
  /** Absolute UTF-16 offset where scanning begins. Defaults to zero. */
  start?: number
  /** Host-language boundary defaults. `interpolation` treats sentence punctuation specially. */
  profile?: JSScanProfile
  /** Behavior when a valid expression is followed by an unfinished continuation. */
  incomplete?: JSIncompleteBehavior
  /** Additional token boundary predicate. It is called before the token is accepted. */
  boundary?: JSScanBoundary
}

export interface CollectedScanTokens {
  tokens: JSToken[]
  boundaryOffset: number
  boundaryToken?: JSToken
  stoppedAtBoundary: boolean
}

export interface CollectScanTokenOptions extends JSScanOptions {
  /** Whether an unknown host character ends the scan or remains a lexer error. */
  unexpectedCharacter?: 'boundary' | 'error'
}

export function collectScanTokens(
  source: string,
  options: Readonly<CollectScanTokenOptions>,
): CollectedScanTokens {
  const start = options.start ?? 0
  const profile = options.profile ?? 'expression'
  const lexer = new JSLexer(source, { start })
  const tokens: JSToken[] = []
  const delimiters: string[] = []

  for (;;) {
    let token: JSToken | undefined
    try {
      token = lexer.nextToken()
    } catch (error) {
      if (
        error instanceof JSLexError &&
        error.code === 'unexpected-character' &&
        options.unexpectedCharacter !== 'error' &&
        tokens.length > 0
      ) {
        return { tokens, boundaryOffset: error.pos, stoppedAtBoundary: true }
      }
      throw error
    }

    if (!token) {
      return { tokens, boundaryOffset: lexer.position, stoppedAtBoundary: false }
    }

    const context: JSScanBoundaryContext = {
      source,
      start,
      token,
      previousToken: tokens[tokens.length - 1],
      depth: delimiters.length,
    }

    if (isStructuralBoundary(token, delimiters)) {
      return {
        tokens,
        boundaryOffset: token.start,
        boundaryToken: token,
        stoppedAtBoundary: true,
      }
    }

    if (
      tokens.length > 0 &&
      (isProfileBoundary(profile, context) || options.boundary?.(context) === true)
    ) {
      return {
        tokens,
        boundaryOffset: token.start,
        boundaryToken: token,
        stoppedAtBoundary: true,
      }
    }

    if (options.maxSourceLength !== undefined && token.end - start > options.maxSourceLength) {
      throw new JSParseError(
        `Expression exceeds maximum source length (${options.maxSourceLength})`,
      )
    }

    tokens.push(token)
    updateDelimiters(token, delimiters)
  }
}

function isStructuralBoundary(token: JSToken, delimiters: readonly string[]): boolean {
  return (
    delimiters.length === 0 &&
    token.kind === 'op' &&
    (token.value === ')' || token.value === ']' || token.value === '}')
  )
}

function isProfileBoundary(profile: JSScanProfile, context: JSScanBoundaryContext): boolean {
  if (profile !== 'interpolation' || context.depth !== 0 || context.token.kind !== 'op') {
    return false
  }

  const { source, token } = context
  if (token.value === ',' || token.value === ';' || token.value === '!') return true
  if (token.value !== '.') return false

  // Member access in this lexer requires an immediately following ASCII identifier.
  const code = source.charCodeAt(token.end)
  return !isIdentifierStartCode(code)
}

function updateDelimiters(token: JSToken, delimiters: string[]): void {
  if (token.kind !== 'op') return
  if (token.value === '(' || token.value === '[' || token.value === '{') {
    delimiters.push(token.value)
    return
  }

  const expected =
    token.value === ')' ? '(' : token.value === ']' ? '[' : token.value === '}' ? '{' : ''
  if (expected && delimiters[delimiters.length - 1] === expected) delimiters.pop()
}

function isIdentifierStartCode(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === 0x24
  )
}
