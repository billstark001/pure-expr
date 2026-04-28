# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
