# pure-expr

pure-expr is an ESM-first TypeScript library for two related jobs:

- parsing and evaluating small JavaScript-like expressions against a controlled context
- parsing and rendering text templates with {{ expression }} placeholders

It also exports the lower-level lexer, parser, evaluator and restricted ESTree AST types.

## Install

```sh
pnpm add pure-expr
```

This package ships both ESM and CommonJS entrypoints and targets modern runtimes.

## Quick Start

```ts
import {
 compile,
 compileTemplate,
 evaluate,
 renderTemplate,
} from 'pure-expr';

const total = evaluate('price * quantity', { price: 12, quantity: 3 });
// 36

const compiled = compile('user.name ?? "anonymous"');
compiled.evaluate({ user: { name: 'Ada' } });
compiled.evaluate({ user: {} });

const rendered = renderTemplate('Hello {{ user.name }}!', {
 user: { name: 'Ada' },
});
// { output: 'Hello Ada!', errors: [] }

const compiledTemplate = compileTemplate('Hello {{ user.name }}!');
compiledTemplate.render({ user: { name: 'Linus' } });
// { output: 'Hello Linus!', errors: [] }
```

## Expected Use Cases

pure-expr is a good fit when you want a small user-editable expression or templating layer without exposing full JavaScript execution.

- Server-side rule and configuration evaluation, such as pricing formulas, feature flags, routing rules, or workflow conditions stored in JSON, YAML, or database records.
- Frontend computed configuration, such as dashboard formulas, conditional UI labels, visibility rules, or low-code style view-model expressions authored outside the application bundle.
- Reusable text generation on the server, such as email bodies, notification payloads, document fragments, and other business templates with `{{ expression }}` placeholders.
- CMS or admin-authored content snippets where non-developers need limited interpolation, formatting helpers, or simple conditional logic without giving them arbitrary code execution.
- Repeated evaluation paths where you parse once and run many times via `compile(...)` or `compileTemplate(...)`, for example in batch jobs, rendering pipelines, or request-time personalization.

It is not a fit for general-purpose plugin execution or sandboxing untrusted JavaScript programs. The package intentionally supports a restricted expression language and a permission-gated call model instead.

## Entry Points

```ts
import { evaluate, compile } from 'pure-expr';
import { parseExpression, tokenizeExpression } from 'pure-expr/expr';
import { parseTemplate, renderTemplate, compileTemplate } from 'pure-expr/template';
```

## Expression Features

The expression engine supports:

- numbers, bigint, strings, booleans, null, undefined, and regex literals
- arrays, objects, spread, property access, optional chaining, and function calls
- unary, binary, logical, ternary, sequence, and Hack-style pipeline operators with `%` topic references
- concise-body arrow functions with JavaScript-style parameter lists, defaults, rest parameters, and destructuring
- JavaScript template literals and tagged template literals

Calls are evaluated through a permission policy. By default, only a conservative set of standard-library calls is allowed; custom functions and methods must be explicitly allowed with evaluator options.

Hack pipes follow the [TC39 Hack-pipe](https://github.com/tc39/proposal-pipeline-operator) shape in this package: the right-hand side is an expression body that must reference `%` at least once, and `%` is only valid inside a pipeline body.

Arrow functions are limited to concise bodies in this package. Block bodies, `function` syntax, and lexical-environment features such as `this`, `arguments`, `super`, and `new.target` are rejected.

For compatibility with the pre-hardening callable behavior, import allowAllCalls and pass it as isCallableAllowed.

Useful expression APIs:

- evaluate(source, scope, options): parse and evaluate once
- compile(source, options): shorter alias for compileExpression(source, options)
- compileExpression(source, options): parse and precompile once, then evaluate many times
- tokenizeExpression(source): inspect lexer output
- parseExpression(source, options): inspect the restricted ESTree AST directly

The expression AST uses standard ESTree nodes wherever the supported syntax has one, including `BinaryExpression`, `ChainExpression`, `ArrowFunctionExpression`, and the standard binding patterns. Hack pipelines are exposed as the explicit `PipelineExpression` and `TopicReference` extensions. Parser offsets are internal and are not emitted. Pass `locations: true` to add standard ESTree `loc` fields, or pass `locations: { startLine, startColumn, source }` to place an expression inside a larger source file. ESTree lines are one-based and columns are zero-based. The package intentionally does not accept or emit the previous lowercase custom AST format.

Useful expression options:

- allowAwait: enable parsing of await expressions in sync mode
- allowArrowFunctions: enable or disable concise-body arrow functions
- allowAssignments: enable parsing assignment and update expressions; evaluation normally enables this automatically when `writes` is not `deny`
- allowMemberWrites: additionally allow member assignment and update targets; evaluation requires `writes: 'commit'`
- allowIn: enable the in operator
- allowCalls: disable all calls, tagged templates, pipeline-internal calls, and arrow-function invocations when set to false
- allowRegexLiterals: disable regex literals when set to false
- allowTemplateLiterals: enable or disable untagged template literals
- allowTaggedTemplates: enable or disable tagged template literals independently
- locations: emit ESTree `loc` fields; an object can set the first source character's `startLine` (default 1), `startColumn` (default 0), and optional `source` name
- functionMode: choose the function-evaluation backend; `default` uses the evaluator-backed closure path and `performance` uses a cached compiled backend for pure-expr-generated arrow functions
- maxSourceLength: reject overly long expression source strings during parsing
- maxAstNodes: reject expressions whose AST exceeds a node-count budget
- maxAstDepth: reject expressions whose AST exceeds a depth budget
- maxArrayElements: reject array literals above a configured element count
- maxObjectProperties: reject object literals above a configured property count
- maxCallArguments: reject calls above a configured argument count
- maxTemplateExpressions: reject template literals above a configured placeholder count
- maxSteps: stop evaluation when the evaluator exceeds a runtime step budget
- contextPolicy: independently control accepted inputs, per-evaluation isolation, and freezing
- writes: control writes with `deny`, `overlay`, `commit`, or `transaction`; member writes are limited to `commit`
- objectLiteralMode: control object-spread hardening with none, filter-blocked, plain-object-only, or safe
- isCallableAllowed: customize which functions, methods, and template tags may execute
- propertyAccess: customize every property and method read; use the exported ownPropertyAccess helper to reject inherited properties
- taggedTemplateArrayMode: use spec-like frozen cached template objects by default, or loose for the older plain-array emulation

### Context Isolation And Mutable Variables

`contextPolicy` is applied afresh on every evaluation:

| Isolation | What the evaluator reads | Valid freeze modes |
| --- | --- | --- |
| `reference` | The caller's object directly | `none` |
| `shallow-snapshot` | A null-prototype copy of own enumerable root bindings | `none`, `shallow` |
| `deep-snapshot` | A recursive copy of a plain-object/array data graph | `none`, `shallow`, `deep` |

Freezing only applies to evaluator-owned snapshots; caller-owned objects are never frozen. Deep snapshots reject accessors, circular references, and non-plain nested objects. `contextPolicy.input` defaults to `plain-only`; use `own-properties` for class-like objects whose own bindings should be visible, or `allow` when function objects are also valid roots.

A compiled expression obtains its context on every call and does not retain an earlier input. An arrow returned by an evaluation intentionally captures that evaluation's reference or snapshot.

Use `createEvaluationEnvironment` when data, host capabilities, and mutable story variables need different policies:

```ts
import {
  createBindingStore,
  createEvaluationEnvironment,
  evaluate,
} from 'pure-expr';

const storyVariables = { score: 1 };
const environment = createEvaluationEnvironment({
  data: { page: { title: 'Example' } },
  dataPolicy: { isolation: 'deep-snapshot', freeze: 'deep' },
  capabilities: { format: (value: unknown) => String(value) },
  variables: createBindingStore(storyVariables),
});

evaluate('score += 2', environment, { writes: 'commit' });
```

Environment lookup order is lexical locals, the current evaluation's overlay, variables, data, then capabilities. Data follows `dataPolicy` or the evaluator's `contextPolicy`; capabilities default to referenced host objects. Variables are explicit live state and are not snapshotted or frozen.

| Write mode | Behavior |
| --- | --- |
| `deny` | Default; context assignment is rejected |
| `overlay` | Writes remain local to the current evaluation |
| `commit` | Writes immediately update the variable store |
| `transaction` | Writes are staged until the returned controller is committed |

```ts
const pending = evaluate('score += 2', environment, {
  writes: 'transaction',
});

pending.value; // 3
pending.changes; // ReadonlyMap { 'score' => 3 }
pending.commit(); // storyVariables.score is now 3
```

Transaction commits restore earlier writes if a later `BindingStore.set` fails. Custom stores that can apply a batch atomically should implement the optional `applyChanges(changes)` method; `createBindingStore` provides it automatically.

Identifier bindings support assignment and prefix/postfix update expressions such as `score++` and `--score`. Pass `allowMemberWrites: true` together with `writes: 'commit'` to enable targets such as `object.value = 1`, `object.value += 1`, or `object.value++`. Member writes are intentionally rejected in `overlay` and `transaction` modes because mutating an object graph cannot be represented or rolled back by the binding store. Blocked prototype-related keys remain inaccessible. Lexical arrow parameters can be reassigned or updated without writing the root context. Template rendering supports `deny`, `overlay`, and `commit`; transaction mode is rejected because placeholders are evaluated separately.

Compatibility example:

```ts
import { allowAllCalls, evaluate } from 'pure-expr';

evaluate('format(name)', {
 name: 'Ada',
 format: (value: string) => value.toUpperCase(),
}, {
 isCallableAllowed: allowAllCalls,
});
```

Hack-pipe and arrow examples:

```ts
import { evaluate } from 'pure-expr';

evaluate('5 |> double(%) |> format(%)', {
 double: (value: number) => value * 2,
 format: (value: number) => `#${value}`,
});
// '#10'

evaluate('((value, suffix = "!") => `${value}${suffix}`)(name)', {
 name: 'Ada',
});
// 'Ada!'
```

For custom pipelines you can also use `JSLexer`, `JSExpressionParser`, `JSEvaluator`, and the exported AST node types.

### Lexer API

`tokenizeExpression(source)` is the simple high-level entry point. Use `JSLexer` when you need exact source spellings, a restricted number syntax, or custom tokens:

```ts
import { JSLexer, type JSLexerRule } from 'pure-expr/expr';

const wordOperators: readonly JSLexerRule[] = [{
 match: (source, position) =>
  source.startsWith('and', position) &&
  !/[a-zA-Z0-9_$]/.test(source[position + 3] ?? ''),
 advance: (_source, position) => ({
  kind: 'op',
  value: '&&',
  start: position,
  end: position + 3,
 }),
}];

const tokens = new JSLexer('enabled and visible', {
 raw: true,
 numbers: {
  radices: [10],
  bigint: false,
  separators: true,
 },
 rules: wordOperators,
}).tokenize();

tokens.map(({ value, raw }) => ({ value, raw }));
// [
//   { value: 'enabled', raw: 'enabled' },
//   { value: '&&', raw: 'and' },
//   { value: 'visible', raw: 'visible' },
// ]
```

Each `JSToken` always has `kind`, `value`, `start`, and `end`. The optional `raw` field is omitted by default to avoid duplicating the source spelling; enable `{ raw: true }` when a custom rule rewrites `value` or tooling needs the original text. Template tokens additionally expose cooked/raw quasis and the token streams for embedded expressions through `tmpl`.

Custom rules are tested in declaration order before built-in tokenization. Their `match` and `advance` callbacks receive the full source, current position, and preceding tokens; normal functions also receive the active lexer as `this`. `advance` must return a token beginning at the current position with a non-empty, in-bounds range. Rules apply recursively inside JavaScript template-literal expressions.

Number policy defaults match the full supported syntax. `numbers.radices` accepts any subset of `2`, `8`, `10`, and `16`; `numbers.bigint` and `numbers.separators` independently control bigint suffixes and numeric separators. These low-level restrictions only apply when constructing `JSLexer` directly.

## Template Features

The template module parses text with repeated-brace placeholders such as {{ expr }} or {{{{ expr }}}}. Rendering can return plain text or HTML-escaped output, and compileTemplate(...) lets you parse and compile template expressions once for repeated rendering.

Template placeholder closing behaves like a repeated-brace delimiter match, similar to how a <script> tag looks for its closing token. The parser does not partially understand the embedded JavaScript while searching for the end of a placeholder; it simply matches the next run of } characters whose length matches the opening delimiter. If the expression source itself contains that same closing run, you must increase the delimiter length on both sides.

Template parsing also accepts maxSourceLength and maxPlaceholders so oversized templates can be rejected before expression evaluation starts.

```ts
import { compileTemplate, parseTemplate, renderTemplate } from 'pure-expr/template';

const parsed = parseTemplate('Hi {{ user.name }}');
const rendered = renderTemplate('Hi {{ user.name }}', {
 user: { name: 'Ada' },
});
const compiled = compileTemplate('Hi {{ user.name }}');
compiled.render({ user: { name: 'Linus' } });
```

renderTemplate(...) and compileTemplate(...) both accept evalOptions plus template-level maxSourceLength and maxPlaceholders so the same call policy, budgets, and context/object hardening can be reused for template expressions.

## Notes And Limits

- The package ships ESM and CommonJS entrypoints. Its emitted syntax targets ES2015 for bundlers and downstream transpilers, but runtime features such as bigint and newer built-ins still depend on the host.
- Expressions are read-only by default. Setting `writes` enables identifier assignment and update expressions; member writes additionally require `allowMemberWrites: true` and immediate commit mode. Statements, `new`, and `delete` remain rejected.
- Evaluation is synchronous. The allowAwait parser flag only enables parsing; it does not create an async evaluator.
- Arrow functions are concise-body only. `this`, `arguments`, `super`, and `new.target` are rejected, and `function` / class definitions remain unsupported.
- Root evaluation contexts must be plain objects or null-prototype objects by default. Set `contextPolicy.input` to `own-properties` or `allow` for explicit non-plain inputs, and choose `shallow-snapshot` when own enumerable bindings should always be copied.
- Getter and Proxy handling still has a platform limitation: JavaScript does not provide a reliable portable Proxy brand check, and reflective inspection may itself trigger Proxy traps while the data graph is being validated/copied. Treat Proxy-backed contexts as unsupported in hardened deployments until a future release offers a stricter strategy.
- pure-expr is not a general-purpose sandbox. It blocks a number of dangerous globals and prototype-chain escape hatches, but allowed host values and functions still execute with normal host semantics.
- Function calls are not fully sandboxed. The default call policy only permits a conservative subset of standard-library functions and methods, plus pure-expr-generated arrow functions; custom or host-provided callables still require explicit approval through isCallableAllowed.
- Object spread filters blocked keys by default. Use objectLiteralMode to opt into legacy behavior, plain-object-only spread, or null-prototype safe object literals.
- Resource controls such as maxSourceLength, AST budgets, maxSteps, allowCalls, and allowRegexLiterals are opt-in. Arrow callbacks share their originating evaluation's step and call-depth budgets, including callbacks invoked repeatedly by allowed host functions.
- The runtime step budget now counts elements expanded through array and call spread syntax.
- Untagged template literals reject invalid escape sequences. Tagged template literals preserve raw text and expose undefined cooked values for those segments.
- Template placeholders do not parse embedded JavaScript while searching for their closing delimiter. If the embedded source contains the same closing brace run as the surrounding delimiter, increase the delimiter length on both sides.
- `compileExpression(...)` precompiles the complete restricted ESTree into cached evaluator closures. The `functionMode: 'performance'` option additionally precompiles pure-expr-generated arrow bodies and parameter binders while preserving the same safety and budget semantics.

## Publishing

Before publishing a new version, bump the version in package.json and merge that change to main. The publish workflow validates the package with the same pnpm run ci pipeline used by CI and refuses to publish a version that already exists on npm.

- Automatic publish: create a GitHub release for the version tag after the version bump lands on main.
- Manual publish: run the Publish to npm workflow from GitHub Actions and choose the ref, npm dist-tag, and whether to run a dry run.
- Authentication: configure npm trusted publishing for GitHub Actions or add an NPM_TOKEN repository secret.
- Local preflight: run pnpm run ci and pnpm pack --dry-run before cutting a release.

## Development

```sh
pnpm install
pnpm run format
pnpm run lint
pnpm run bench:expr
pnpm run bench:context
pnpm run bench:template
pnpm run bench:lexer
pnpm run ci
```

The expr benchmark compares direct evaluate(...) calls with precompiled compile(...).evaluate(...) calls across arithmetic-heavy, member-access-heavy, property-policy, optional-chain, call-heavy, template-literal-heavy, short repeated, and Hack-pipe-heavy expressions. It also reports arrow-function creation and invocation throughput for both the `default` and `performance` function backends, including snapshot captures and mutable lexical parameters, plus parser throughput with and without location metadata.

The context benchmark compares compiled evaluation throughput across reference, shallow-snapshot, deep-snapshot, freeze, full data/capability/variable layering, overlay, commit, and transaction policies. It includes both small and wide context shapes so fixed per-evaluation costs and snapshot scaling remain visible.

The template benchmark compares direct renderTemplate(...) calls with precompiled compileTemplate(...).render(...) calls across member-heavy, call-heavy, HTML-escaped, short repeated, and layered committed-write templates.

The lexer benchmark reports source and token throughput for the default path, source retention with `raw: true`, number-policy validation, and ordered custom-rule misses, early hits, late hits, and combined raw-token paths.
