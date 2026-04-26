import { type EvalOptions, JSEvalError, JSLexError, JSParseError, evaluate } from '../expr/index.js'
import { parseTemplate, type TemplateParseOptions, type TemplateRenderError } from './parser.js'

// #region Template render types

/** Output encoding mode for renderTemplate. */
export type TemplateFormat = 'text' | 'html'

/** Rendering controls for template evaluation. */
export interface RenderTemplateOptions extends TemplateParseOptions {
  format?: TemplateFormat
  /** When true, stop on first evaluation error. */
  strict?: boolean
  /** Expression-evaluation options forwarded to the underlying evaluator. */
  evalOptions?: EvalOptions
}

/** Result returned by renderTemplate. */
export interface TemplateRenderResult {
  output: string
  errors: TemplateRenderError[]
}

// #endregion

// #region Render helpers

function classifyError(error: unknown): TemplateRenderError['kind'] {
  if (error instanceof JSLexError) return 'lex'
  if (error instanceof JSParseError) return 'parse'
  if (error instanceof JSEvalError) return 'eval'
  return 'template'
}

function toStringValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  return String(value)
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// #endregion

// #region Public renderer

/** Render a template source string against a scope object. */
export function renderTemplate(
  source: string,
  context: Record<string, unknown>,
  options: RenderTemplateOptions = {},
): TemplateRenderResult {
  const parsed = parseTemplate(source, options)
  const errors = [...parsed.errors]
  const out: string[] = []
  const isHtml = options.format === 'html'

  for (const segment of parsed.segments) {
    if (segment.type === 'text') {
      out.push(segment.value)
      continue
    }

    try {
      const value = evaluate(segment.expr, context, options.evalOptions)
      const text = toStringValue(value)
      out.push(isHtml ? escapeHtml(text) : text)
    } catch (error) {
      errors.push({
        expression: segment.expr,
        message: error instanceof Error ? error.message : 'unknown template error',
        start: segment.start,
        end: segment.end,
        kind: classifyError(error),
      })
      if (options.strict) {
        break
      }
    }
  }

  return {
    output: out.join(''),
    errors,
  }
}

// #endregion
