# pure-expr

pure-expr is an ESM-first TypeScript library for two related jobs:

- parsing and evaluating small JavaScript-like expressions against a readonly scope
- parsing and rendering text templates with {{ expression }} placeholders

It also exports the lower-level lexer, parser, evaluator and AST types.

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
- compileExpression(source, options): parse once and evaluate many times
- tokenizeExpression(source): inspect lexer output
- parseExpression(source, options): inspect the AST directly

Useful expression options:

- allowAwait: enable parsing of await expressions in sync mode
- allowArrowFunctions: enable or disable concise-body arrow functions
- allowIn: enable the in operator
- allowCalls: disable all calls, tagged templates, pipeline-internal calls, and arrow-function invocations when set to false
- allowRegexLiterals: disable regex literals when set to false
- allowTemplateLiterals: enable or disable untagged template literals
- allowTaggedTemplates: enable or disable tagged template literals independently
- functionMode: choose the function-evaluation backend; `default` uses the evaluator-backed closure path and `performance` uses a cached compiled backend for pure-expr-generated arrow functions
- maxSourceLength: reject overly long expression source strings during parsing
- maxAstNodes: reject expressions whose AST exceeds a node-count budget
- maxAstDepth: reject expressions whose AST exceeds a depth budget
- maxArrayElements: reject array literals above a configured element count
- maxObjectProperties: reject object literals above a configured property count
- maxCallArguments: reject calls above a configured argument count
- maxTemplateExpressions: reject template literals above a configured placeholder count
- maxSteps: stop evaluation when the evaluator exceeds a runtime step budget
- rootContextMode: control root-scope normalization with allow, copy-non-plain-to-null-prototype, require-plain-object, or copy-plain-data-to-null-prototype
- objectLiteralMode: control object-spread hardening with none, filter-blocked, plain-object-only, or safe
- isCallableAllowed: customize which functions, methods, and template tags may execute
- taggedTemplateArrayMode: use spec-like frozen cached template objects by default, or loose for the older plain-array emulation

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

For custom pipelines you can also use JSLexer, JSExpressionParser, JSEvaluator, and the exported AST node types.

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

- The published package now ships both ESM and CommonJS entrypoints. import resolves to the ESM build by default, while require() resolves to the CJS build.
- The emitted package syntax targets ES2015 for distribution compatibility, but that is not a full ES2015 runtime guarantee. The evaluator still exposes newer language/runtime features such as bigint handling and whichever standard-library methods exist in the host runtime.
- In practice, ES2015 is a reasonable emit baseline for bundlers and downstream transpilers, but it is not sufficient if you need this package itself to run unchanged on old engines with no bigint or newer built-ins.
- Expressions are intentionally read-only. Statements and assignment operators are rejected.
- Evaluation is synchronous. The allowAwait parser flag only enables parsing; it does not create an async evaluator.
- Arrow functions are concise-body only. `this`, `arguments`, `super`, and `new.target` are rejected, and `function` / class definitions remain unsupported.
- Root evaluation contexts must be plain objects or null-prototype objects by default. Use rootContextMode to opt into copying non-plain roots, allowing them unchanged, or deep-copying a plain data graph with copy-plain-data-to-null-prototype.
- copy-plain-data-to-null-prototype rejects accessor properties and circular references anywhere in the root data graph, and it clones plain-object/array data into null-prototype/plain-array containers before evaluation.
- Getter and Proxy handling still has a platform limitation: JavaScript does not provide a reliable portable Proxy brand check, and reflective inspection may itself trigger Proxy traps while the data graph is being validated/copied. Treat Proxy-backed contexts as unsupported in hardened deployments until a future release offers a stricter strategy.
- pure-expr is not a general-purpose sandbox. It blocks a number of dangerous globals and prototype-chain escape hatches, but allowed host values and functions still execute with normal host semantics.
- Function calls are not fully sandboxed. The default call policy only permits a conservative subset of standard-library functions and methods, plus pure-expr-generated arrow functions; custom or host-provided callables still require explicit approval through isCallableAllowed.
- Object spread filters blocked keys by default. Use objectLiteralMode to opt into legacy behavior, plain-object-only spread, or null-prototype safe object literals.
- Resource controls such as maxSourceLength, AST budgets, maxSteps, allowCalls, and allowRegexLiterals are opt-in.
- The runtime step budget now counts elements expanded through array and call spread syntax.
- Untagged template literals reject invalid escape sequences. Tagged template literals preserve raw text and expose undefined cooked values for those segments.
- Template placeholders do not parse embedded JavaScript while searching for their closing delimiter. If the embedded source contains the same closing brace run as the surrounding delimiter, increase the delimiter length on both sides.
- The `functionMode: 'performance'` option is implemented for pure-expr-generated arrow functions. It keeps the same language and safety semantics as the default mode, but uses a cached compiled execution path for arrow bodies. Non-function expressions still use the standard evaluator path.

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
pnpm run bench:template
pnpm run ci
```

The expr benchmark compares direct evaluate(...) calls with precompiled compile(...).evaluate(...) calls across arithmetic-heavy, member-access-heavy, call-heavy, template-literal-heavy, short repeated, and Hack-pipe-heavy expressions. It also reports arrow-function creation and invocation throughput for both the `default` and `performance` function backends.

The template benchmark compares direct renderTemplate(...) calls with precompiled compileTemplate(...).render(...) calls across member-heavy, call-heavy, HTML-escaped, and short repeated templates.
