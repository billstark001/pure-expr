# Templates

The template module supports repeated-brace placeholders such as `{{ expr }}` or `{{{{ expr }}}}`. Its incremental expression scan understands strings, regular expressions, comments, template literals, and nested delimiters while locating the matching outer brace run. Consequently, `{{ "}}" }}`, `{{ /* }} */ value }}`, and object literals work without increasing the delimiter length.

Invalid embedded syntax still uses the next matching raw brace run as a recovery boundary, allowing later template content to be processed.

## Parsing, Rendering, and Compilation

```ts
import {
  compileTemplate,
  parseTemplate,
  renderTemplate,
} from 'pure-expr/template';

const parsed = parseTemplate('Hi {{ user.name }}');

const rendered = renderTemplate('Hi {{ user.name }}', {
  user: { name: 'Ada' },
});

const compiled = compileTemplate('Hi {{ user.name }}');
compiled.render({ user: { name: 'Linus' } });
```

Use `compileTemplate(...)` when the same template will be rendered repeatedly. Compilation reuses the tokens collected by the boundary scan and compiles the AST directly instead of parsing valid placeholders twice.

## Dollar Interpolation

Set `syntax` to `dollar` or `both` to enable concise interpolation beginning with a dollar-prefixed identifier. The dollar sign remains part of the identifier, so `$user.name` reads the `$user` context binding.

Inline interpolation accepts only a root identifier followed by adjacent property access, optional chaining, calls, or computed access. Whitespace and top-level operators end it; use braces for arbitrary expressions. `$$` emits one literal dollar sign, and currency-like text such as `$100` is unchanged.

```ts
renderTemplate(
  'Hi $user.name! Total: {{ $price * $quantity }}; $$5 is literal.',
  { $user: { name: 'Ada' }, $price: 12, $quantity: 3 },
  { syntax: 'both' },
);
```

Dollar interpolation is opt-in, so the default `braces` syntax preserves literal dollar-prefixed text.

## Options and Limits

`parseTemplate(...)`, `renderTemplate(...)`, and `compileTemplate(...)` accept:

- `syntax`: `braces`, `dollar`, or `both`
- `maxSourceLength`: maximum template source length
- `maxPlaceholders`: shared budget for brace and dollar placeholders

Rendering and compilation also accept `evalOptions`, so the same call policy, expression budgets, and context/object hardening can be reused for every placeholder. See [Evaluation and safety](evaluation-and-safety.md).

Brace placeholders use lexical structure to ignore apparent closing runs inside strings, comments, regular expressions, template literals, and nested delimiters. For malformed lexical input, raw delimiter matching is used only as an error-recovery boundary.
