# pure-expr

pure-expr is an ESM-first TypeScript library for evaluating small JavaScript-like expressions against a controlled context and rendering text templates. It also exposes its lexer, parser, evaluator, and restricted ESTree AST types.

## Install

```sh
pnpm add pure-expr
```

The package ships ESM and CommonJS entrypoints and targets modern runtimes.

## Basic Usage

Evaluate an expression once:

```ts
import { evaluate } from 'pure-expr';

const total = evaluate('price * quantity', {
  price: 12,
  quantity: 3,
});
// 36
```

Compile an expression when it will be evaluated repeatedly:

```ts
import { compile } from 'pure-expr';

const greeting = compile('`Hello ${user.name}!`');

greeting.evaluate({ user: { name: 'Ada' } });
// 'Hello Ada!'
```

Render a template:

```ts
import { renderTemplate } from 'pure-expr';

const result = renderTemplate('Hello {{ user.name }}!', {
  user: { name: 'Grace' },
});
// { output: 'Hello Grace!', errors: [] }
```

Function calls are permission-gated, expressions are read-only by default, and this package is not a general-purpose JavaScript sandbox.

## Documentation

- [Expressions](docs/expressions.md) — syntax, parsing, scanning, ASTs, and the lexer
- [Evaluation and safety](docs/evaluation-and-safety.md) — call permissions, context isolation, writes, budgets, and security limits
- [Templates](docs/templates.md) — brace and dollar interpolation, parsing, rendering, and compilation
- [Development and publishing](docs/development.md) — local checks, benchmarks, and release workflow

## License

[MIT](LICENSE)
