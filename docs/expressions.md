# Expressions

The expression engine supports:

- numbers, bigint, strings, booleans, null, undefined, and regex literals
- arrays, objects, spread, property access, optional chaining, and function calls
- unary, binary, logical, ternary, sequence, and Hack-style pipeline operators with `%` topic references
- concise-body arrow functions with JavaScript-style parameter lists, defaults, rest parameters, and destructuring
- JavaScript template literals and tagged template literals

Hack pipes follow the [TC39 Hack-pipe](https://github.com/tc39/proposal-pipeline-operator) shape: the right-hand side is an expression body that must reference `%` at least once, and `%` is only valid inside a pipeline body.

Arrow functions are limited to concise bodies. Block bodies, `function` syntax, and lexical-environment features such as `this`, `arguments`, `super`, and `new.target` are rejected.

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

## APIs and ASTs

Useful expression APIs:

- `evaluate(source, scope, options)` parses and evaluates once.
- `compile(source, options)` is a shorter alias for `compileExpression(source, options)`.
- `compileExpression(source, options)` parses and precompiles once, then evaluates many times.
- `tokenizeExpression(source)` returns lexer tokens.
- `parseExpression(source, options)` returns the restricted ESTree AST.
- `scanExpression(source, options)` reads one expression from a larger host-language string.
- `parseBindingPattern(source, options)` parses a standalone ESTree binding pattern.
- `scanBindingPattern(source, options)` reads one binding pattern from a larger string.
- `parseIterationClause(source, options)` parses a contextual `<binding> of <expression>` DSL clause.

The AST uses standard ESTree nodes wherever the supported syntax has one, including `BinaryExpression`, `ChainExpression`, `ArrowFunctionExpression`, and standard binding patterns. Hack pipelines use the `PipelineExpression` and `TopicReference` extensions. Parser offsets are internal and are not emitted.

Pass `locations: true` to add standard ESTree `loc` fields, or pass `locations: { startLine, startColumn, source }` to place an expression inside a larger source file. ESTree lines are one-based and columns are zero-based. The package does not accept or emit the previous lowercase custom AST format.

For custom pipelines, you can use `JSLexer`, `JSExpressionParser`, `JSEvaluator`, and the exported AST node types directly.

## Host-Language Scanning

`scanExpression(...)` reads one expression beginning at an absolute source offset and returns the AST together with its exact range, the first unconsumed offset, and why scanning stopped. The default `expression` profile follows the expression grammar. The `interpolation` profile additionally treats top-level commas, semicolons, postfix-looking `!`, and a dot without an immediately adjacent property name as host-text boundaries.

```ts
import { scanExpression } from 'pure-expr/expr';

const source = 'You are $user.name, welcome!';
const scanned = scanExpression(source, {
  start: source.indexOf('$'),
  profile: 'interpolation',
});

source.slice(scanned.start, scanned.end); // '$user.name'
scanned.next; // offset of ','
scanned.stoppedBy; // 'boundary'
```

Nested punctuation remains part of the expression, so `$format(first, last), ...` stops at the outer comma rather than the call-argument comma. The interpolation dot rule requires adjacency: `$user.name` continues through the dot, while `$job.` and `$user . name` stop before it.

By default, an unfinished continuation such as `value +`, `object.`, or `fn(` raises `JSIncompleteParseError`. Pass `incomplete: 'rollback'` to return the most recent complete top-level expression instead:

```ts
const scanned = scanExpression('value +', { incomplete: 'rollback' });
// expression: Identifier('value')
// stoppedBy: 'incomplete'
// next: offset of '+'
```

Rollback applies only to source exhaustion after a valid continuation begins. Hard syntax errors such as `value + * other`, malformed literals, and unterminated strings, regular expressions, comments, or template literals still throw. A custom `boundary` predicate receives the next token and current delimiter depth before that token is accepted, allowing host DSLs to define contextual separators without adding operators to the expression language.

Scanner-only options are:

- `start`: absolute UTF-16 source offset at which scanning begins
- `profile`: `expression` by default, or `interpolation` for common surrounding-text punctuation
- `incomplete`: `error` by default, or `rollback` to return the last complete top-level prefix
- `boundary`: an additional token predicate for contextual host-language separators

## Binding Patterns and Iteration Clauses

Binding patterns use the same identifiers, destructuring grammar, default-value expression parser, locations, and resource budgets as arrow parameters:

```ts
import {
  parseBindingPattern,
  parseIterationClause,
  scanBindingPattern,
} from 'pure-expr/expr';

parseBindingPattern('{ id: local, values: [first, ...rest] }');

const clause = parseIterationClause('[item, index] of entries.filter(active)');
// clause.binding: ArrayPattern
// clause.iterable: CallExpression
```

`of` is contextual in `parseIterationClause(...)`; it is not a binary operator and cannot be evaluated as `left of right`. For other DSL separators, use `scanBindingPattern(...)` with a `boundary` predicate, then parse or scan the remaining expression independently.

## Parser Options

- `allowAwait`: enable parsing of await expressions in sync mode
- `allowArrowFunctions`: enable or disable concise-body arrow functions
- `allowAssignments`: enable parsing assignment and update expressions; evaluation normally enables this automatically when `writes` is not `deny`
- `allowMemberWrites`: additionally allow member assignment and update targets; evaluation requires `writes: 'commit'`
- `allowIn`: enable the `in` operator
- `allowCalls`: disable all calls, tagged templates, pipeline-internal calls, and arrow-function invocations when set to `false`
- `allowRegexLiterals`: disable regex literals when set to `false`
- `allowTemplateLiterals`: enable or disable untagged template literals
- `allowTaggedTemplates`: enable or disable tagged template literals independently
- `locations`: emit ESTree `loc` fields; an object can set the first source character's `startLine` (default 1), `startColumn` (default 0), and optional `source` name
- `maxSourceLength`: reject overly long expression source strings
- `maxAstNodes`: reject ASTs above a node-count budget
- `maxAstDepth`: reject ASTs above a depth budget
- `maxArrayElements`: reject array literals above an element-count budget
- `maxObjectProperties`: reject object literals above a property-count budget
- `maxCallArguments`: reject calls above an argument-count budget
- `maxTemplateExpressions`: reject template literals above a placeholder-count budget

Evaluation-specific options are covered in [Evaluation and safety](evaluation-and-safety.md).

## Lexer API

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

`JSLexer` also supports incremental reads and absolute starting offsets. `nextToken()` returns one token while preserving the same previous-token context used by `tokenize()`; a later `tokenize()` call returns the remaining tokens.

```ts
const source = 'prefix value + 1';
const lexer = new JSLexer(source, { start: source.indexOf('value') });

lexer.nextToken(); // identifier `value` with absolute offsets
lexer.tokenize(); // `+`, `1`
```

Each `JSToken` always has `kind`, `value`, `start`, and `end`. The optional `raw` field is omitted by default; enable `{ raw: true }` when a custom rule rewrites `value` or tooling needs the original text. Template tokens additionally expose cooked/raw quasis and the token streams for embedded expressions through `tmpl`.

`JSLexError.code` classifies failures as `invalid`, `unexpected-character`, or `unterminated`. Scanners treat only an unexpected character after an already tokenized prefix as a host boundary; malformed and unterminated lexical constructs remain errors.

Custom rules are tested in declaration order before built-in tokenization. Their `match` and `advance` callbacks receive the full source, current position, and preceding tokens; normal functions also receive the active lexer as `this`. `advance` must return a token beginning at the current position with a non-empty, in-bounds range. Rules apply recursively inside JavaScript template-literal expressions.

Number policy defaults match the full supported syntax. `numbers.radices` accepts any subset of `2`, `8`, `10`, and `16`; `numbers.bigint` and `numbers.separators` independently control bigint suffixes and numeric separators. These low-level restrictions apply only when constructing `JSLexer` directly.
