import type { JSToken } from '../expr/lexer/types.js'
import {
  type CollectedScanTokens,
  collectScanTokens,
  type JSScanBoundaryContext,
} from '../expr/parser/scanner.js'

// #region Template parser types

/** Error captured while parsing or rendering a template. */
export interface TemplateRenderError {
  kind: 'template' | 'lex' | 'parse' | 'eval'
  message: string
  expression: string
  start: number
  end: number
}

/** Placeholder syntaxes recognized by the template parser. */
export type TemplateSyntax = 'braces' | 'dollar' | 'both'

/** Expression placeholder segment inside a template string. */
export interface TemplateExpressionSegment {
  type: 'expression'
  syntax: 'braces' | 'dollar'
  expr: string
  /** Complete placeholder range, including braces or the dollar-prefixed expression. */
  start: number
  end: number
  /** Expression source range inside the complete template source. */
  expressionStart: number
  expressionEnd: number
  /** Opening/closing brace count, or one for dollar interpolation. */
  delimiterLength: number
}

/** Plain-text segment inside a template string. */
export interface TemplateTextSegment {
  type: 'text'
  value: string
}

/** One parsed template segment. */
export type TemplateSegment = TemplateTextSegment | TemplateExpressionSegment

/** Parsed template representation. */
export interface TemplateParseResult {
  segments: TemplateSegment[]
  errors: TemplateRenderError[]
}

/** Parser-level controls for text templates. */
export interface TemplateParseOptions {
  maxSourceLength?: number
  maxPlaceholders?: number
  /** Placeholder syntax. Dollar interpolation is opt-in; braces remain the default. */
  syntax?: TemplateSyntax
}

/** Internal expression segment retaining the tokens collected while finding its boundary. */
export interface ScannedTemplateExpressionSegment extends TemplateExpressionSegment {
  tokens?: JSToken[]
}

export type ScannedTemplateSegment = TemplateTextSegment | ScannedTemplateExpressionSegment

export interface ScannedTemplateParseResult {
  segments: ScannedTemplateSegment[]
  errors: TemplateRenderError[]
}

// #endregion

// #region Template parser helpers

function makeTemplateError(message: string, start: number, end: number): TemplateRenderError {
  return {
    expression: '',
    message,
    start,
    end,
    kind: 'template',
  }
}

function budgetExceeded(message: string, start: number, end: number): ScannedTemplateParseResult {
  return {
    segments: [],
    errors: [makeTemplateError(message, start, end)],
  }
}

function readBraceRun(source: string, from: number, brace: '{' | '}'): number {
  let i = from
  while (i < source.length && source[i] === brace) i += 1
  return i - from
}

function findRawExpressionClose(source: string, from: number, delimiterLength: number): number {
  return source.indexOf('}'.repeat(delimiterLength), from)
}

function appendText(segments: ScannedTemplateSegment[], value: string): void {
  if (!value) return
  const previous = segments[segments.length - 1]
  if (previous?.type === 'text') previous.value += value
  else segments.push({ type: 'text', value })
}

function expressionRange(source: string, start: number, end: number) {
  const raw = source.slice(start, end)
  const expr = raw.trim()
  if (!expr) return { expr, expressionStart: start, expressionEnd: start }
  const leadingLength = raw.length - raw.trimStart().length
  return {
    expr,
    expressionStart: start + leadingLength,
    expressionEnd: start + leadingLength + expr.length,
  }
}

function createBraceSegment(
  source: string,
  start: number,
  expressionSourceStart: number,
  closeStart: number,
  delimiterLength: number,
  tokens?: JSToken[],
): ScannedTemplateExpressionSegment {
  return {
    type: 'expression',
    syntax: 'braces',
    ...expressionRange(source, expressionSourceStart, closeStart),
    start,
    end: closeStart + delimiterLength,
    delimiterLength,
    tokens,
  }
}

function scanBraceSegment(
  source: string,
  start: number,
  delimiterLength: number,
): ScannedTemplateExpressionSegment | undefined {
  const expressionSourceStart = start + delimiterLength

  try {
    const collected = collectScanTokens(source, {
      start: expressionSourceStart,
      unexpectedCharacter: 'error',
    })
    const boundary = collected.boundaryToken
    if (
      boundary?.kind === 'op' &&
      boundary.value === '}' &&
      readBraceRun(source, boundary.start, '}') >= delimiterLength
    ) {
      return createBraceSegment(
        source,
        start,
        expressionSourceStart,
        boundary.start,
        delimiterLength,
        collected.tokens,
      )
    }
  } catch {
    // Invalid embedded syntax still needs a deterministic host-language recovery boundary.
  }

  const closeStart = findRawExpressionClose(source, expressionSourceStart, delimiterLength)
  if (closeStart < 0) return undefined
  return createBraceSegment(source, start, expressionSourceStart, closeStart, delimiterLength)
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
}

function isDollarInterpolationStart(source: string, index: number): boolean {
  const next = source.charCodeAt(index + 1)
  return isAsciiLetter(next) || next === 0x5f
}

function isInlineBoundary({ depth, previousToken, token }: JSScanBoundaryContext): boolean {
  if (depth !== 0 || !previousToken) return false
  if (token.start > previousToken.end) return true

  if (token.kind === 'identifier') {
    return !(
      previousToken.kind === 'op' &&
      (previousToken.value === '.' || previousToken.value === '?.')
    )
  }

  return !(
    token.kind === 'op' &&
    (token.value === '.' || token.value === '?.' || token.value === '(' || token.value === '[')
  )
}

function scanDollarSegment(
  source: string,
  start: number,
): ScannedTemplateExpressionSegment | undefined {
  let collected: CollectedScanTokens
  try {
    collected = collectScanTokens(source, {
      start,
      profile: 'interpolation',
      boundary: isInlineBoundary,
    })
  } catch {
    return {
      type: 'expression',
      syntax: 'dollar',
      expr: source.slice(start),
      start,
      end: source.length,
      expressionStart: start,
      expressionEnd: source.length,
      delimiterLength: 1,
    }
  }
  const first = collected.tokens[0]
  const last = collected.tokens[collected.tokens.length - 1]
  if (
    !first ||
    !last ||
    first.start !== start ||
    first.kind !== 'identifier' ||
    !first.value.startsWith('$')
  ) {
    return undefined
  }

  return {
    type: 'expression',
    syntax: 'dollar',
    expr: source.slice(start, last.end),
    start,
    end: last.end,
    expressionStart: start,
    expressionEnd: last.end,
    delimiterLength: 1,
    tokens: collected.tokens,
  }
}

function publicSegment(segment: ScannedTemplateSegment): TemplateSegment {
  if (segment.type === 'text') return segment
  const { tokens: _tokens, ...result } = segment
  return result
}

// #endregion

// #region Public template parser

/** Internal single-pass template scan shared by parsing and compilation. */
export function scanTemplateSource(
  source: string,
  options: TemplateParseOptions = {},
): ScannedTemplateParseResult {
  if (options.maxSourceLength !== undefined && source.length > options.maxSourceLength) {
    return budgetExceeded(
      `Template exceeds maximum source length (${options.maxSourceLength})`,
      0,
      source.length,
    )
  }

  const syntax = options.syntax ?? 'braces'
  const bracesEnabled = syntax === 'braces' || syntax === 'both'
  const dollarEnabled = syntax === 'dollar' || syntax === 'both'
  const segments: ScannedTemplateSegment[] = []
  const errors: TemplateRenderError[] = []
  let i = 0
  let textStart = 0
  let placeholderCount = 0

  const reservePlaceholder = (start: number): ScannedTemplateParseResult | undefined => {
    if (options.maxPlaceholders !== undefined && placeholderCount >= options.maxPlaceholders) {
      return budgetExceeded(
        `Template exceeds maximum placeholder count (${options.maxPlaceholders})`,
        start,
        source.length,
      )
    }
    placeholderCount += 1
    return undefined
  }

  while (i < source.length) {
    if (bracesEnabled && source[i] === '{') {
      const delimiterLength = readBraceRun(source, i, '{')
      if (delimiterLength >= 2) {
        const exceeded = reservePlaceholder(i)
        if (exceeded) return exceeded
        appendText(segments, source.slice(textStart, i))

        const segment = scanBraceSegment(source, i, delimiterLength)
        if (!segment) {
          errors.push(makeTemplateError('Unclosed template expression', i, source.length))
          appendText(segments, source.slice(i))
          return { segments, errors }
        }

        segments.push(segment)
        i = segment.end
        textStart = i
        continue
      }
    }

    if (dollarEnabled && source[i] === '$') {
      if (source[i + 1] === '$') {
        appendText(segments, source.slice(textStart, i))
        appendText(segments, '$')
        i += 2
        textStart = i
        continue
      }

      if (isDollarInterpolationStart(source, i)) {
        const exceeded = reservePlaceholder(i)
        if (exceeded) return exceeded
        appendText(segments, source.slice(textStart, i))
        const segment = scanDollarSegment(source, i)
        if (segment) {
          segments.push(segment)
          i = segment.end
          textStart = i
          continue
        }
        placeholderCount -= 1
      }
    }

    i += 1
  }

  appendText(segments, source.slice(textStart))
  return { segments, errors }
}

/** Parse a text template with brace and optional dollar-prefixed placeholders. */
export function parseTemplate(
  source: string,
  options: TemplateParseOptions = {},
): TemplateParseResult {
  const parsed = scanTemplateSource(source, options)
  return {
    segments: parsed.segments.map(publicSegment),
    errors: parsed.errors,
  }
}

// #endregion
