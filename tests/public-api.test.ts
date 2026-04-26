import { describe, expect, test } from 'vitest';

import {
  compile,
  compileExpression,
  JSEvaluator,
  parseExpression,
  parseTemplate,
  renderTemplate,
  tokenizeExpression,
} from '../src/index.js';

describe('public API', () => {
  test('tokenizeExpression exposes lexer output', () => {
    expect(tokenizeExpression('count + 1').map((token) => token.raw)).toEqual([
      'count',
      '+',
      '1',
    ]);
  });

  test('parseExpression exposes the expression AST', () => {
    expect(parseExpression('count + 1')).toMatchObject({
      type: 'binary',
      operator: '+',
    });
  });

  test('compileExpression supports reusable evaluation', () => {
    const compiled = compileExpression('count + 1');

    expect(compiled.evaluate({ count: 1 })).toBe(2);
    expect(compiled.evaluate({ count: 4 })).toBe(5);
  });

  test('compile alias is exported from the root entrypoint', () => {
    const compiled = compile('count + 2');

    expect(compiled.source).toBe('count + 2');
    expect(compiled.evaluate({ count: 3 })).toBe(5);
  });

  test('JSEvaluator merges base and per-call contexts without leaking overrides', () => {
    const evaluator = new JSEvaluator({ count: 1, step: 2 });
    const ast = parseExpression('count + step');

    expect(evaluator.evaluate(ast)).toBe(3);
    expect(evaluator.evaluate(ast, { count: 5 })).toBe(7);
    expect(evaluator.evaluate(ast)).toBe(3);
  });

  test('template helpers remain available from the root entrypoint', () => {
    expect(parseTemplate('Hi {{ name }}').segments).toHaveLength(2);
    expect(renderTemplate('Hi {{ name }}', { name: 'Ada' }).output).toBe('Hi Ada');
  });

});