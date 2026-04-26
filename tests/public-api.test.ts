import { describe, expect, test } from 'vitest';

import {
  PrattParser,
  compileExpression,
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

  test('template helpers remain available from the root entrypoint', () => {
    expect(parseTemplate('Hi {{ name }}').segments).toHaveLength(2);
    expect(renderTemplate('Hi {{ name }}', { name: 'Ada' }).output).toBe('Hi Ada');
  });

  test('generic pratt parser is exported', () => {
    const parser = new PrattParser({
      operators: {
        '+': { precedence: 10, infix: true },
      },
    });

    const ast = parser.parse([
      { type: 'expr', value: 1 },
      { type: 'opr', value: '+' },
      { type: 'expr', value: 2 },
    ]);

    expect(ast).toMatchObject({
      type: 'binary',
      operator: '+',
      left: { type: 'leaf', value: 1 },
      right: { type: 'leaf', value: 2 },
    });
  });
});