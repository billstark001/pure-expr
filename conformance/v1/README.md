# pure-expr conformance corpus v1

`corpus.json` is the implementation-neutral behavioral contract frozen from the 182 TypeScript
tests that existed when the corpus was introduced. One legacy test maps to exactly one corpus
case; a case may contain multiple checks when the original test made multiple assertions.

The corpus uses JSON only. A new implementation can consume it without running JavaScript or
reading the original test files. `sourceTest` is provenance, not executable input.

## Versions

- `schemaVersion` changes when the JSON structure or operation vocabulary changes incompatibly.
- `corpusVersion` versions behavioral content.
- `semanticProfile` identifies the semantics being frozen. Version 1 captures the existing
  JavaScript-hosted behavior and is named `legacy-js-v1`.

## Encoded values and fixtures

Ordinary nulls, booleans, numbers, strings, arrays, and objects use their JSON representation.
Values that JSON cannot represent use a tagged object:

```json
{ "$conformance": "undefined" }
{ "$conformance": "bigint", "value": "9007199254740993" }
{ "$conformance": "regex", "source": "abc", "flags": "gi" }
```

Input-only fixtures use the same marker. They describe behavior rather than JavaScript source:

```json
{ "$conformance": "callable", "name": "multiply", "factor": 2 }
{ "$conformance": "builtin", "name": "Math" }
{ "$conformance": "class-instance", "own": { "count": 2 } }
```

Callable fixture names and their required behavior are exercised by `tests/conformance.test.ts`.
Ports should implement the same small fixture registry in their own corpus adapter. Cases with a
`portability` property identify behavior coupled to callbacks, JavaScript prototypes, template
objects, or the current host call policy.

## Operations

The v1 operation vocabulary is:

- `evaluate`, `parse-expression`, and `tokenize-expression`
- `compile-evaluate` and `evaluator-evaluate`
- `parse-template`, `render-template`, and `compile-template-render`
- `call-permission`
- `compiled-nested-evaluate`, a focused re-entrant compiled-expression scenario

Options are ordinary JSON. `callPolicy: "allow-all"` is an implementation-neutral symbolic value
that adapters translate to their permissive host-call policy, including when nested under
`evalOptions`.

Expectations can contain an exact `value`, a partial structural `match`, JSON-pointer-like `paths`,
or an `error`. Error kinds are `lex`, `parse`, `eval`, and `host`. Optional observations freeze
callback traces and result prototype properties where the legacy behavior depends on them.

## Maintenance

Generate the checked-in corpus after intentionally changing definitions:

```sh
pnpm run conformance:generate
```

Verify that `corpus.json` is current without writing files:

```sh
pnpm run conformance:check
```

The generator reads all legacy test names and fails on a missing, duplicate, or extra definition.
The Vitest adapter executes every checked-in case against the TypeScript reference implementation.

