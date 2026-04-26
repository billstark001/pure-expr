/** Error captured while parsing or rendering a template. */
export interface TemplateRenderError {
  kind: 'template' | 'lex' | 'parse' | 'eval';
  message: string;
  expression: string;
  start: number;
  end: number;
}

/** Expression placeholder segment inside a template string. */
export interface TemplateExpressionSegment {
  type: 'expression';
  expr: string;
  start: number;
  end: number;
  delimiterLength: number;
}

/** Plain-text segment inside a template string. */
export interface TemplateTextSegment {
  type: 'text';
  value: string;
}

/** One parsed template segment. */
export type TemplateSegment = TemplateTextSegment | TemplateExpressionSegment;

/** Parsed template representation. */
export interface TemplateParseResult {
  segments: TemplateSegment[];
  errors: TemplateRenderError[];
}

/** Parser-level budget controls for text templates. */
export interface TemplateParseOptions {
  maxSourceLength?: number;
  maxPlaceholders?: number;
}

function isQuote(ch: string): boolean {
  return ch === '"' || ch === '\'' || ch === '`';
}

function makeTemplateError(message: string, start: number, end: number): TemplateRenderError {
  return {
    expression: '',
    message,
    start,
    end,
    kind: 'template',
  };
}

function budgetExceeded(message: string, start: number, end: number): TemplateParseResult {
  return {
    segments: [],
    errors: [makeTemplateError(message, start, end)],
  };
}

function readBraceRun(source: string, from: number, brace: '{' | '}'): number {
  let i = from;
  while (i < source.length && source[i] === brace) i += 1;
  return i - from;
}

function findExpressionClose(source: string, from: number, delimiterLength: number): number {
  let i = from;
  let braceDepth = 0;
  let quote: string | null = null;

  while (i < source.length) {
    const ch = source[i];

    if (quote) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (isQuote(ch)) {
      quote = ch;
      i += 1;
      continue;
    }

    if (ch === '{') {
      braceDepth += 1;
      i += 1;
      continue;
    }

    if (ch === '}') {
      if (braceDepth > 0) {
        braceDepth -= 1;
        i += 1;
        continue;
      }
      const run = readBraceRun(source, i, '}');
      if (run >= delimiterLength) {
        return i;
      }
      i += 1;
      continue;
    }

    i += 1;
  }

  return -1;
}

/** Parse a text template with {{ expr }} style placeholders. */
export function parseTemplate(source: string, options: TemplateParseOptions = {}): TemplateParseResult {
  if (options.maxSourceLength !== undefined && source.length > options.maxSourceLength) {
    return budgetExceeded(`Template exceeds maximum source length (${options.maxSourceLength})`, 0, source.length);
  }

  const segments: TemplateSegment[] = [];
  const errors: TemplateRenderError[] = [];
  let i = 0;
  let textStart = 0;
  let placeholderCount = 0;

  while (i < source.length) {
    if (source[i] !== '{') {
      i += 1;
      continue;
    }

    const openLen = readBraceRun(source, i, '{');
    if (openLen < 2) {
      i += 1;
      continue;
    }

    if (options.maxPlaceholders !== undefined && placeholderCount >= options.maxPlaceholders) {
      return budgetExceeded(`Template exceeds maximum placeholder count (${options.maxPlaceholders})`, i, source.length);
    }

    if (i > textStart) {
      segments.push({ type: 'text', value: source.slice(textStart, i) });
    }

    const exprStart = i + openLen;
    const closePos = findExpressionClose(source, exprStart, openLen);
    if (closePos < 0) {
      errors.push(makeTemplateError('Unclosed template expression', i, source.length));
      segments.push({ type: 'text', value: source.slice(i) });
      return { segments, errors };
    }

    const expr = source.slice(exprStart, closePos).trim();
    segments.push({
      type: 'expression',
      expr,
      start: i,
      end: closePos + openLen,
      delimiterLength: openLen,
    });
    placeholderCount += 1;

    i = closePos + openLen;
    textStart = i;
  }

  if (textStart < source.length) {
    segments.push({ type: 'text', value: source.slice(textStart) });
  }

  return { segments, errors };
}
