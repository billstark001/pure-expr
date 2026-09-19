import { parserOptionsForEvaluation } from '../expr/evaluator/options.js'
import {
  type EvalOptions,
  type EvaluationInput,
  JSEvalError,
  JSEvaluator,
  JSLexError,
  JSParseError,
  parseExpression,
} from '../expr/index.js'
import { validateSourceLength, validateSyntaxBudget } from '../expr/parser/budget.js'
import { JSExpressionParser } from '../expr/parser/parser.js'
import {
  type ScannedTemplateExpressionSegment,
  type ScannedTemplateSegment,
  scanTemplateSource,
  type TemplateExpressionSegment,
  type TemplateParseOptions,
  type TemplateRenderError,
  type TemplateSegment,
  type TemplateTextSegment,
} from './parser.js'

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

/** Compilation controls for reusable template rendering. */
export interface CompileTemplateOptions extends RenderTemplateOptions {}

/** Render-time overrides for a compiled template. */
export interface CompiledTemplateRenderOptions {
  format?: TemplateFormat
  strict?: boolean
}

/** Parsed template that can be rendered repeatedly with different scopes. */
export interface CompiledTemplate {
  readonly source: string
  readonly segments: readonly TemplateSegment[]
  render(context?: EvaluationInput, options?: CompiledTemplateRenderOptions): TemplateRenderResult
}

// #endregion

// #region Render helpers

interface CompiledTemplateExpressionSegment extends TemplateExpressionSegment {
  execute?: (context?: EvaluationInput) => unknown
  precomputedError?: TemplateRenderError
}

type CompiledTemplateSegment = TemplateTextSegment | CompiledTemplateExpressionSegment

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

function toTemplateExpressionError(
  error: unknown,
  segment: TemplateExpressionSegment,
): TemplateRenderError {
  return {
    expression: segment.expr,
    message: error instanceof Error ? error.message : 'unknown template error',
    start: segment.start,
    end: segment.end,
    kind: classifyError(error),
  }
}

function buildCompiledTemplateSegments(
  source: string,
  segments: readonly ScannedTemplateSegment[],
  options: Readonly<CompileTemplateOptions>,
): CompiledTemplateSegment[] {
  const evalOptions = options.evalOptions ?? {}
  const parserOptions = parserOptionsForEvaluation(evalOptions)
  const evaluator = new JSEvaluator(undefined, evalOptions)

  return segments.map((segment) => {
    if (segment.type === 'text') return segment
    const publicExpression = toPublicExpressionSegment(segment)

    try {
      validateSourceLength(segment.expr, parserOptions)
      const ast = segment.tokens
        ? new JSExpressionParser(segment.tokens, parserOptions, source).parse()
        : parseExpression(segment.expr, parserOptions)
      if (segment.tokens) validateSyntaxBudget(ast, parserOptions, 'expression')
      return {
        ...publicExpression,
        execute: evaluator.compile(ast),
      }
    } catch (error) {
      return {
        ...publicExpression,
        precomputedError: toTemplateExpressionError(error, publicExpression),
      }
    }
  })
}

function toPublicExpressionSegment(
  segment: ScannedTemplateExpressionSegment,
): TemplateExpressionSegment {
  const { tokens: _tokens, ...result } = segment
  return result
}

function renderCompiledTemplateSegments(
  segments: readonly CompiledTemplateSegment[],
  initialErrors: readonly TemplateRenderError[],
  context: EvaluationInput,
  format: TemplateFormat,
  strict: boolean,
): TemplateRenderResult {
  const errors = [...initialErrors]
  const out: string[] = []
  const isHtml = format === 'html'

  for (const segment of segments) {
    if (segment.type === 'text') {
      out.push(segment.value)
      continue
    }

    if (segment.precomputedError) {
      errors.push(segment.precomputedError)
      if (strict) break
      continue
    }

    try {
      const value = segment.execute!(context)
      const text = toStringValue(value)
      out.push(isHtml ? escapeHtml(text) : text)
    } catch (error) {
      errors.push(toTemplateExpressionError(error, segment))
      if (strict) {
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

// #region Public renderer

/** Parse and compile a template source string for repeated rendering. */
export function compileTemplate(
  source: string,
  options: CompileTemplateOptions = {},
): CompiledTemplate {
  if (options.evalOptions?.writes === 'transaction') {
    throw new TypeError(
      "Template rendering does not support writes: 'transaction'; use 'commit' with an explicit BindingStore",
    )
  }
  const parsed = scanTemplateSource(source, options)
  const compiledSegments = buildCompiledTemplateSegments(source, parsed.segments, options)
  const publicSegments = parsed.segments.map(
    (segment): TemplateSegment =>
      segment.type === 'text' ? segment : toPublicExpressionSegment(segment),
  )
  const defaultFormat = options.format ?? 'text'
  const defaultStrict = options.strict ?? false

  return {
    source,
    segments: publicSegments,
    render(
      context: EvaluationInput = {},
      renderOptions: CompiledTemplateRenderOptions = {},
    ): TemplateRenderResult {
      return renderCompiledTemplateSegments(
        compiledSegments,
        parsed.errors,
        context,
        renderOptions.format ?? defaultFormat,
        renderOptions.strict ?? defaultStrict,
      )
    },
  }
}

/** Render a template source string against a scope object. */
export function renderTemplate(
  source: string,
  context: EvaluationInput,
  options: RenderTemplateOptions = {},
): TemplateRenderResult {
  return compileTemplate(source, options).render(context)
}

// #endregion
