# simple-expr

simple-expr is an ESM-first TypeScript library for two related jobs:

- parsing and evaluating small JavaScript-like expressions against a readonly scope
- parsing and rendering text templates with {{ expression }} placeholders

It also exports the lower-level lexer, parser, evaluator and AST types.

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

Calls are evaluated through a permission policy. By default, only a conservative set of standard-library calls is allowed; custom functions and methods must be explicitly allowed with evaluator options.

For compatibility with the pre-hardening callable behavior, import allowAllCalls and pass it as isCallableAllowed.

Useful expression APIs:

- evaluate(source, scope, options): parse and evaluate once
- compile(source, options): shorter alias for compileExpression(source, options)
- compileExpression(source, options): parse once and evaluate many times
- tokenizeExpression(source): inspect lexer output
- parseExpression(source, options): inspect the AST directly

Useful expression options:

- allowAwait: enable parsing of await expressions in sync mode
- allowIn: enable the in operator
- allowCalls: disable all calls, tagged templates, and pipelines when set to false
- allowRegexLiterals: disable regex literals when set to false
- allowTemplateLiterals: enable or disable untagged template literals
- allowTaggedTemplates: enable or disable tagged template literals independently
- maxSourceLength: reject overly long expression source strings during parsing
- maxAstNodes: reject expressions whose AST exceeds a node-count budget
- maxAstDepth: reject expressions whose AST exceeds a depth budget
- maxArrayElements: reject array literals above a configured element count
- maxObjectProperties: reject object literals above a configured property count
- maxCallArguments: reject calls above a configured argument count
- maxTemplateExpressions: reject template literals above a configured placeholder count
- maxSteps: stop evaluation when the evaluator exceeds a runtime step budget
- rootContextMode: control root-scope normalization with allow, copy-non-plain-to-null-prototype, or require-plain-object
- objectLiteralMode: control object-spread hardening with none, filter-blocked, plain-object-only, or safe
- isCallableAllowed: customize which functions, methods, and template tags may execute
- taggedTemplateArrayMode: use spec-like frozen cached template objects by default, or loose for the older plain-array emulation

Compatibility example:

```ts
import { allowAllCalls, evaluate } from 'simple-expr';

evaluate('format(name)', {
 name: 'Ada',
 format: (value: string) => value.toUpperCase(),
}, {
 isCallableAllowed: allowAllCalls,
});
```

For custom pipelines you can also use JSLexer, JSExpressionParser, JSEvaluator, and the exported AST node types.

## Template Features

The template module parses text with repeated-brace placeholders such as {{ expr }} or {{{{ expr }}}}. Rendering can return plain text or HTML-escaped output.

Template parsing also accepts maxSourceLength and maxPlaceholders so oversized templates can be rejected before expression evaluation starts.

```ts
import { parseTemplate, renderTemplate } from 'simple-expr/template';

const parsed = parseTemplate('Hi {{ user.name }}');
const rendered = renderTemplate('Hi {{ user.name }}', {
 user: { name: 'Ada' },
});
```

renderTemplate(...) also accepts evalOptions plus template-level maxSourceLength and maxPlaceholders so the same call policy, budgets, and context/object hardening can be reused for template expressions.

## Notes And Limits

- The package is ESM-only. CommonJS require() is not supported.
- Expressions are intentionally read-only. Statements and assignment operators are rejected.
- Evaluation is synchronous. The allowAwait parser flag only enables parsing; it does not create an async evaluator.
- Root evaluation contexts must be plain objects or null-prototype objects by default. Use rootContextMode to opt into copying non-plain roots or allowing them unchanged.
- Function calls are not fully sandboxed. The default call policy only permits a conservative subset of standard-library functions and methods; custom or host-provided callables require explicit approval through isCallableAllowed.
- Object spread filters blocked keys by default. Use objectLiteralMode to opt into legacy behavior, plain-object-only spread, or null-prototype safe object literals.
- Resource controls such as maxSourceLength, AST budgets, maxSteps, allowCalls, and allowRegexLiterals are opt-in.
- Untagged template literals reject invalid escape sequences. Tagged template literals preserve raw text and expose undefined cooked values for those segments.
- Dangerous globals and prototype-chain escape hatches are blocked, but user-provided functions still run as provided.

## Development

```sh
pnpm install
pnpm run bench:expr
pnpm run ci
```

The benchmark command compares direct evaluate(...) calls with precompiled compile(...).evaluate(...) calls across arithmetic-heavy, member-access-heavy, call-heavy, template-literal-heavy, and short repeated expressions.
