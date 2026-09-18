# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.3.0 - 2026-09-18

### Added

- Added optional ESTree `loc` generation with configurable starting line, starting column, and source name.
- Added injectable `propertyAccess` evaluation policies and exported `inheritedPropertyAccess` and `ownPropertyAccess` policy helpers.
- Added `ChainExpression` evaluation with JavaScript-compatible optional-chain short-circuit propagation.
- Added configurable lexer number policies, ordered custom lexer rules, optional raw source preservation, and a public lexer position.
- Added a lexer-focused throughput benchmark covering raw source retention and custom rules.

### Changed

- Public expression node types now derive from ESTree without exposing the parser's internal `start` and `end` offsets.
- Replaced the public custom AST with a restricted ESTree representation based on `@types/estree`. Hack pipelines remain explicit `PipelineExpression` and `TopicReference` extensions.
- Represented `undefined` as an ESTree `Identifier`, split tagged templates into `TaggedTemplateExpression` and `TemplateLiteral`, and represented arrow parameters with standard ESTree patterns.
- Arrow-function calls now share execution-step and call-depth budgets with their originating evaluation.
- `compileExpression` now precompiles the complete expression tree for repeated evaluation; performance-mode arrows also precompile their bodies and parameter binders.
- Removed all compatibility aliases for the previous AST node types and field names.
- Lexer tokens now expose their parser-facing spelling as `value`; exact source spelling is available as optional `raw` data when requested.

### Fixed

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
