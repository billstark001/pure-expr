# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.4.0 - 2026-09-19

### Added

- Added `scanExpression(...)` for reading an expression prefix from a larger host-language source with absolute ranges, stop reasons, contextual boundary predicates, and an interpolation-oriented punctuation profile.
- Added structured `JSIncompleteParseError` failures and opt-in top-level rollback for unfinished continuations such as `value +`, `object.`, and `fn(` while preserving hard syntax and lexical errors.
- Added standalone `parseBindingPattern(...)` and `scanBindingPattern(...)` entry points backed by the same destructuring and default-expression grammar used for arrow parameters.
- Added `parseIterationClause(...)` for contextual `<binding> of <expression>` DSL clauses without introducing `of` as an evaluable binary operator.
- Added incremental `JSLexer.nextToken()` reads and absolute lexer starting offsets.
- Added a parser/scanner benchmark covering complete scans, interpolation boundaries, incomplete rollback, binding patterns, and iteration clauses.
- Added opt-in `dollar` and `both` template syntaxes for concise `$name`, member, optional-chain, call, and computed-access interpolation, with `$$` escaping and literal `$100` handling.

### Changed

- Generalized the arrow-parameter binding parser into a reusable binding-pattern grammar and shared property-key conversion between object expressions and object bindings.
- Classified lexer failures as invalid, unexpected-character, or unterminated so host scanners can stop at unknown surrounding text without hiding malformed literals or comments.
- Extended AST node-count and depth budgets, location generation, and topic validation to standalone binding-pattern entry points.
- Made brace template boundaries lexer-aware so closing-brace runs inside strings, comments, regular expressions, template literals, object literals, and other nested structures no longer terminate placeholders early.
- Reused the incremental scan's tokens and compiled the resulting AST directly during template compilation, removing the previous second tokenization and parse pass for valid placeholders.
- Added absolute expression ranges and syntax metadata to parsed template expression segments.

### Tests

- Added scanner coverage for absolute offsets, nested punctuation, natural-language interpolation, custom contextual keywords, incomplete rollback, hard-error preservation, binding destructuring, and iteration clauses.
- Added template coverage for lexical brace boundaries, dollar interpolation and escaping, mixed syntax, shared placeholder budgets, and malformed inline expressions.

## 0.3.0 - 2026-09-18

### Added

- Added ECMAScript prefix and postfix update expressions (`++` and `--`) for writable identifier bindings, including Number and BigInt semantics.
- Added opt-in member assignment and update targets through `allowMemberWrites` in immediate commit mode.
- Added optional ESTree `loc` generation with configurable starting line, starting column, and source name.
- Added layered evaluation environments for separately isolated data, host capabilities, and mutable `BindingStore` variables.
- Added explicit reference, shallow-snapshot, and deep-snapshot context isolation with safe shallow/deep freezing.
- Added restricted identifier assignments with deny, overlay, commit, and transaction write modes.
- Added a context-policy benchmark covering isolation, freezing, layered environments, and write modes.
- Added injectable `propertyAccess` evaluation policies and exported `inheritedPropertyAccess` and `ownPropertyAccess` policy helpers.
- Added `ChainExpression` evaluation with JavaScript-compatible optional-chain short-circuit propagation.
- Added configurable lexer number policies, ordered custom lexer rules, optional raw source preservation, and a public lexer position.
- Added a lexer-focused throughput benchmark covering raw source retention and custom rules.

### Changed

- Expanded the context benchmark with member assignment, compound assignment, and update cases.
- Simplified evaluator state variants and isolated arrow-runtime caches by compilation strategy.
- Context benchmarks now report sample spread and reset mutable fixtures before warmup and measurement.
- Public expression node types now derive from ESTree without exposing the parser's internal `start` and `end` offsets.
- Replaced `rootContextMode` with the orthogonal `contextPolicy`; shallow snapshots now always copy own enumerable bindings regardless of the input object's prototype.
- Compiled expressions now acquire call-time contexts on every evaluation; escaped arrows inherit that evaluation's isolation semantics.
- Restored reference-context throughput with allocation-light compiled and arrow-scope fast paths while retaining mutable lexical captures.
- Migrated the Biome recommended-rules configuration to the `preset` field.
- Replaced the public custom AST with a restricted ESTree representation based on `@types/estree`. Hack pipelines remain explicit `PipelineExpression` and `TopicReference` extensions.
- Represented `undefined` as an ESTree `Identifier`, split tagged templates into `TaggedTemplateExpression` and `TemplateLiteral`, and represented arrow parameters with standard ESTree patterns.
- Arrow-function calls now share execution-step and call-depth budgets with their originating evaluation.
- `compileExpression` now precompiles the complete expression tree for repeated evaluation; performance-mode arrows also precompile their bodies and parameter binders.
- Removed all compatibility aliases for the previous AST node types and field names.
- Lexer tokens now expose their parser-facing spelling as `value`; exact source spelling is available as optional `raw` data when requested.

### Fixed

- Overlay writes now remain visible across arrow-call frames for the lifetime of an evaluation.
- Transaction commits now roll back earlier writes when a later binding-store write fails.
- Fixed optional chains such as `obj?.a.b` and `obj?.method()` so the complete unparenthesized chain short-circuits, while parentheses correctly terminate propagation.
- Applied property access policies consistently to property reads, method reads, tagged template receivers, and object destructuring.

## 0.2.0 - 2026-04-28

### Added

- Added support for the Hack-style pipeline operator with `%` topic references inside expression bodies.
- Added concise-body arrow functions in expressions, including default parameters, rest parameters, and destructuring bindings.
- Added AST and public API coverage for pipeline and arrow-function parsing and evaluation paths.

### Changed

- Reorganized the expression parser and evaluator into focused internal modules for bindings, grammar, validation, calls, operations, compilation, and runtime state.
- Expanded the expression benchmark to compare native V8 execution against direct evaluation, compiled evaluation, and compiled arrow-function backends.

### Tests

- Expanded evaluator and public API coverage for Hack-pipe and arrow-function behavior, including validation and edge cases.

## 0.1.0 - 2026-04-26

Initial version.
