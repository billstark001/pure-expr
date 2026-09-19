# Evaluation and Safety

pure-expr is useful when you need a small user-editable expression layer without exposing full JavaScript execution. Typical uses include server-side rules and pricing formulas, frontend computed configuration, low-code visibility rules, CMS-authored snippets, and repeated evaluation paths that parse once and run many times.

It is not suitable for general-purpose plugin execution or sandboxing untrusted JavaScript programs. The package intentionally supports a restricted expression language and a permission-gated call model.

## Call Permissions

By default, only a conservative set of standard-library calls is allowed. Custom functions, methods, and template tags must be explicitly approved with `isCallableAllowed`.

For compatibility with the pre-hardening callable behavior, pass `allowAllCalls` as the policy:

```ts
import { allowAllCalls, evaluate } from 'pure-expr';

evaluate(
  'format(name)',
  {
    name: 'Ada',
    format: (value: string) => value.toUpperCase(),
  },
  { isCallableAllowed: allowAllCalls },
);
```

## Evaluation Options

- `functionMode`: choose the function-evaluation backend; `default` uses evaluator-backed closures and `performance` uses a cached compiled backend for pure-expr-generated arrow functions
- `maxSteps`: stop evaluation when the evaluator exceeds a runtime step budget
- `contextPolicy`: independently control accepted inputs, per-evaluation isolation, and freezing
- `writes`: control writes with `deny`, `overlay`, `commit`, or `transaction`; member writes are limited to `commit`
- `objectLiteralMode`: control object-spread hardening with `none`, `filter-blocked`, `plain-object-only`, or `safe`
- `isCallableAllowed`: customize which functions, methods, and template tags may execute
- `propertyAccess`: customize every property and method read; use `ownPropertyAccess` to reject inherited properties
- `taggedTemplateArrayMode`: use spec-like frozen cached template objects by default, or `loose` for the older plain-array emulation

Parser switches and AST budgets are listed in [Expressions](expressions.md#parser-options).

## Context Isolation

`contextPolicy` is applied afresh on every evaluation:

| Isolation | What the evaluator reads | Valid freeze modes |
| --- | --- | --- |
| `reference` | The caller's object directly | `none` |
| `shallow-snapshot` | A null-prototype copy of own enumerable root bindings | `none`, `shallow` |
| `deep-snapshot` | A recursive copy of a plain-object/array data graph | `none`, `shallow`, `deep` |

Freezing applies only to evaluator-owned snapshots; caller-owned objects are never frozen. Deep snapshots reject accessors, circular references, and non-plain nested objects. `contextPolicy.input` defaults to `plain-only`; use `own-properties` for class-like objects whose own bindings should be visible, or `allow` when function objects are also valid roots.

A compiled expression obtains its context on every call and does not retain an earlier input. An arrow returned by an evaluation intentionally captures that evaluation's reference or snapshot.

## Data, Capabilities, and Mutable Variables

Use `createEvaluationEnvironment` when data, host capabilities, and mutable variables need different policies:

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

Lookup order is lexical locals, the current evaluation's overlay, variables, data, then capabilities. Data follows `dataPolicy` or the evaluator's `contextPolicy`; capabilities default to referenced host objects. Variables are explicit live state and are not snapshotted or frozen.

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

Identifier bindings support assignment and prefix/postfix update expressions such as `score++` and `--score`. Pass `allowMemberWrites: true` with `writes: 'commit'` to enable targets such as `object.value = 1`, `object.value += 1`, or `object.value++`.

Member writes are rejected in `overlay` and `transaction` modes because mutating an object graph cannot be represented or rolled back by the binding store. Blocked prototype-related keys remain inaccessible. Lexical arrow parameters can be reassigned or updated without writing the root context. Template rendering supports `deny`, `overlay`, and `commit`; transaction mode is rejected because placeholders are evaluated separately.

## Security and Runtime Limits

- Expressions are read-only by default. Statements, `new`, and `delete` are rejected.
- Evaluation is synchronous. `allowAwait` only enables parsing; it does not create an async evaluator.
- Root contexts must be plain or null-prototype objects by default. Use `contextPolicy.input` to explicitly allow other inputs.
- Getter and Proxy handling has a platform limitation: JavaScript has no reliable portable Proxy brand check, and reflective inspection can trigger Proxy traps. Treat Proxy-backed contexts as unsupported in hardened deployments.
- pure-expr blocks dangerous globals and prototype-chain escape hatches, but allowed host values and functions still execute with normal host semantics.
- Function calls are not fully sandboxed. Host-provided callables require explicit approval through `isCallableAllowed`.
- Object spread filters blocked keys by default. `objectLiteralMode` can select legacy behavior, plain-object-only spread, or null-prototype safe object literals.
- Resource controls such as source length, AST budgets, `maxSteps`, `allowCalls`, and `allowRegexLiterals` are opt-in. Arrow callbacks share the originating evaluation's step and call-depth budgets, including callbacks invoked repeatedly by allowed host functions.
- The runtime step budget counts elements expanded through array and call spread syntax.
- Untagged template literals reject invalid escape sequences. Tagged template literals preserve raw text and expose undefined cooked values for those segments.
- Expression scanning cannot infer author intent when host text is itself a valid continuation. Select the interpolation profile or provide a boundary predicate for ambiguous host syntaxes.
- `compileExpression(...)` precompiles the complete restricted ESTree into cached evaluator closures. `functionMode: 'performance'` additionally precompiles generated arrow bodies and parameter binders while preserving the same safety and budget semantics.
- The emitted syntax targets ES2015 for bundlers and downstream transpilers, but runtime features such as bigint and newer built-ins still depend on the host.
