# Development and Publishing

## Local Development

```sh
pnpm install
pnpm run format
pnpm run lint
pnpm run bench:expr
pnpm run bench:context
pnpm run bench:template
pnpm run bench:lexer
pnpm run bench:scanner
pnpm run ci
```

The expression benchmark compares direct `evaluate(...)` calls with precompiled `compile(...).evaluate(...)` calls across arithmetic, member access, property policies, optional chains, calls, template literals, repeated short expressions, and Hack pipes. It also covers arrow-function creation and invocation for both function backends, snapshot captures, mutable lexical parameters, and parser throughput with and without locations.

The context benchmark compares reference, shallow-snapshot, deep-snapshot, freeze, layered environment, overlay, commit, and transaction policies across small and wide context shapes.

The template benchmark compares direct rendering with compiled templates across member-heavy, call-heavy, HTML-escaped, repeated short, and layered committed-write templates.

The lexer benchmark reports source and token throughput for the default path, raw source retention, number-policy validation, and custom-rule paths.

The scanner benchmark compares strict parsing, complete-expression scanning, interpolation boundaries, incomplete rollback, binding patterns, contextual binding scans, and iteration clauses.

## Publishing

Before publishing, bump the version in `package.json` and merge that change to `main`. The publish workflow validates the package with the same `pnpm run ci` pipeline used by CI and refuses to publish a version that already exists on npm.

- Automatic publish: create a GitHub release for the version tag after the version bump lands on `main`.
- Manual publish: run the **Publish to npm** workflow from GitHub Actions and choose the ref, npm dist-tag, and whether to perform a dry run.
- Authentication: configure npm trusted publishing for GitHub Actions or add an `NPM_TOKEN` repository secret.
- Local preflight: run `pnpm run ci` and `pnpm pack --dry-run` before cutting a release.
