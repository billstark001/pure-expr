import { JSEvalError, JSLexError, JSParseError, evaluate } from '../expr/index.js';
import { parseTemplate, TemplateRenderError } from './parser.js';

/** Output encoding mode for renderTemplate. */
export type TemplateFormat = 'text' | 'html';

/** Rendering controls for template evaluation. */
export interface RenderTemplateOptions {
  format?: TemplateFormat;
  /** When true, stop on first evaluation error. */
  strict?: boolean;
}

/** Result returned by renderTemplate. */
export interface TemplateRenderResult {
  output: string;
  errors: TemplateRenderError[];
}

function classifyError(error: unknown): TemplateRenderError['kind'] {
  if (error instanceof JSLexError) return 'lex';
  if (error instanceof JSParseError) return 'parse';
  if (error instanceof JSEvalError) return 'eval';
  return 'template';
}

function toStringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return String(value);
}

function escapeHtml(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Render a template source string against a scope object. */
export function renderTemplate(
  source: string,
  context: Record<string, unknown>,
  options: RenderTemplateOptions = {},
): TemplateRenderResult {
  const parsed = parseTemplate(source);
  const errors = [...parsed.errors];
  const out: string[] = [];
  const isHtml = options.format === 'html';

  for (const segment of parsed.segments) {
    if (segment.type === 'text') {
      out.push(segment.value);
      continue;
    }

    try {
      const value = evaluate(segment.expr, context);
      const text = toStringValue(value);
      out.push(isHtml ? escapeHtml(text) : text);
    } catch (error) {
      errors.push({
        expression: segment.expr,
        message: error instanceof Error ? error.message : 'unknown template error',
        start: segment.start,
        end: segment.end,
        kind: classifyError(error),
      });
      if (options.strict) {
        break;
      }
    }
  }

  return {
    output: out.join(''),
    errors,
  };
}
