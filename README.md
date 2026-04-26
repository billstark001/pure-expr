# simple-expr

simple-expr is an ESM-first TypeScript library for two related jobs:

- parsing and evaluating small JavaScript-like expressions against a readonly scope
- parsing and rendering text templates with {{ expression }} placeholders

It also exports the lower-level lexer, parser, evaluator, AST types, and a generic Pratt parser utility for custom integrations.

## Install

```sh
pnpm add simple-expr
```

This package is ESM-only and targets modern runtimes.

## Quick Start

```ts
import {
 compile,
 evaluate,
 renderTemplate,
} from 'simple-expr';

const total = evaluate('price * quantity', { price: 12, quantity: 3 });
// 36

const compiled = compile('user.name ?? "anonymous"');
compiled.evaluate({ user: { name: 'Ada' } });
compiled.evaluate({ user: {} });

const rendered = renderTemplate('Hello {{ user.name }}!', {
 user: { name: 'Ada' },
});
// { output: 'Hello Ada!', errors: [] }
```

## Entry Points

```ts
import { evaluate, compile } from 'simple-expr';
import { parseExpression, tokenizeExpression } from 'simple-expr/expr';
import { parseTemplate, renderTemplate } from 'simple-expr/template';
```

## Expression Features

The expression engine supports:

- numbers, bigint, strings, booleans, null, undefined, and regex literals
- arrays, objects, spread, property access, optional chaining, and function calls
- unary, binary, logical, ternary, sequence, and pipeline operators
- JavaScript template literals and tagged template literals

Useful expression APIs:

- evaluate(source, scope, options): parse and evaluate once
- compile(source, options): shorter alias for compileExpression(source, options)
- compileExpression(source, options): parse once and evaluate many times
- tokenizeExpression(source): inspect lexer output
- parseExpression(source, options): inspect the AST directly

Useful expression options:

- allowAwait: enable parsing of await expressions in sync mode
- allowIn: enable the in operator
- allowTemplateLiterals: enable or disable untagged template literals
- allowTaggedTemplates: enable or disable tagged template literals independently
- taggedTemplateArrayMode: use spec-like frozen cached template objects by default, or loose for the older plain-array emulation

For custom pipelines you can also use JSLexer, JSExpressionParser, JSEvaluator, the exported AST node types, and PrattParser.

## Template Features

The template module parses text with repeated-brace placeholders such as {{ expr }} or {{{{ expr }}}}. Rendering can return plain text or HTML-escaped output.

```ts
import { parseTemplate, renderTemplate } from 'simple-expr/template';

const parsed = parseTemplate('Hi {{ user.name }}');
const rendered = renderTemplate('Hi {{ user.name }}', {
 user: { name: 'Ada' },
});
```

## Notes And Limits

- The package is ESM-only. CommonJS require() is not supported.
- Expressions are intentionally read-only. Statements and assignment operators are rejected.
- Evaluation is synchronous. The allowAwait parser flag only enables parsing; it does not create an async evaluator.
- Untagged template literals reject invalid escape sequences. Tagged template literals preserve raw text and expose undefined cooked values for those segments.
- Dangerous globals and prototype-chain escape hatches are blocked, but user-provided functions still run as provided.

## Development

```sh
pnpm install
pnpm run bench:expr
pnpm run ci
```

The benchmark command compares direct evaluate(...) calls with precompiled compile(...).evaluate(...) calls across arithmetic-heavy, member-access-heavy, call-heavy, template-literal-heavy, and short repeated expressions.
