import { describe, expect, test } from 'vitest'
import {
  allowAllCalls,
  createBindingStore,
  createEvaluationEnvironment,
} from '../src/expr/index.js'
import { compileTemplate, parseTemplate, renderTemplate } from '../src/template/index.js'

// #region Template parser coverage

describe('template parser', () => {
  test('parses plain text', () => {
    const parsed = parseTemplate('hello world')
    expect(parsed.errors).toHaveLength(0)
    expect(parsed.segments).toEqual([{ type: 'text', value: 'hello world' }])
  })

  test('parses expression with double braces', () => {
    const parsed = parseTemplate('Hi {{ user.name }}!')
    expect(parsed.errors).toHaveLength(0)
    expect(parsed.segments).toHaveLength(3)
    expect(parsed.segments[1]).toMatchObject({
      type: 'expression',
      expr: 'user.name',
      delimiterLength: 2,
    })
  })

  test('supports longer matching delimiters', () => {
    const parsed = parseTemplate('Value: {{{{ a + 1 }}}}')
    expect(parsed.errors).toHaveLength(0)
    expect(parsed.segments[1]).toMatchObject({
      type: 'expression',
      expr: 'a + 1',
      delimiterLength: 4,
    })
  })

  test('keeps object literal braces inside expression', () => {
    const parsed = parseTemplate('X {{ ({ a: 1 }).a }} Y')
    expect(parsed.errors).toHaveLength(0)
    expect(parsed.segments[1]).toMatchObject({
      type: 'expression',
      expr: '({ a: 1 }).a',
    })
  })

  test('supports longer delimiters when the expression contains a shorter closing run', () => {
    const parsed = parseTemplate('Value: {{{{ "}}" }}}}')

    expect(parsed.errors).toHaveLength(0)
    expect(parsed.segments[1]).toMatchObject({
      type: 'expression',
      expr: '"}}"',
      delimiterLength: 4,
    })
  })

  test('ignores closing delimiter runs inside comments', () => {
    const parsed = parseTemplate('A {{ /* }} */ 1 }} B')

    expect(parsed.errors).toHaveLength(0)
    expect(parsed.segments[1]).toMatchObject({
      type: 'expression',
      syntax: 'braces',
      expr: '/* }} */ 1',
      delimiterLength: 2,
    })
    expect(parsed.segments[2]).toEqual({ type: 'text', value: ' B' })
  })

  test('ignores closing delimiter runs inside strings with ordinary braces', () => {
    const parsed = parseTemplate('A {{ "}}" }} B')

    expect(parsed.errors).toHaveLength(0)
    expect(parsed.segments[1]).toMatchObject({
      type: 'expression',
      expr: '"}}"',
      expressionStart: 5,
      expressionEnd: 9,
    })
  })

  test('keeps dollar interpolation opt-in', () => {
    expect(parseTemplate('Hi $user.name!').segments).toEqual([
      { type: 'text', value: 'Hi $user.name!' },
    ])
  })

  test('parses conservative dollar interpolation and escapes literal dollars', () => {
    const parsed = parseTemplate('Hi $user.name! $$cost is $100.', { syntax: 'dollar' })

    expect(parsed.errors).toHaveLength(0)
    expect(parsed.segments).toEqual([
      { type: 'text', value: 'Hi ' },
      {
        type: 'expression',
        syntax: 'dollar',
        expr: '$user.name',
        start: 3,
        end: 13,
        expressionStart: 3,
        expressionEnd: 13,
        delimiterLength: 1,
      },
      { type: 'text', value: '! $cost is $100.' },
    ])
  })

  test('allows nested arguments but stops dollar interpolation at top-level whitespace', () => {
    const parsed = parseTemplate('$format($user.name, "long name") and $other', {
      syntax: 'dollar',
    })

    expect(parsed.segments).toMatchObject([
      { type: 'expression', expr: '$format($user.name, "long name")' },
      { type: 'text', value: ' and ' },
      { type: 'expression', expr: '$other' },
    ])
  })

  test('reports unclosed expression', () => {
    const parsed = parseTemplate('Hi {{ user.name')
    expect(parsed.errors).toHaveLength(1)
    expect(parsed.errors[0]?.kind).toBe('template')
  })

  test('rejects oversized template sources', () => {
    const parsed = parseTemplate('hello world', { maxSourceLength: 5 })

    expect(parsed.segments).toEqual([])
    expect(parsed.errors[0]?.message).toContain('maximum source length')
  })

  test('rejects templates with too many placeholders', () => {
    const parsed = parseTemplate('A {{ first }} B {{ second }}', { maxPlaceholders: 1 })

    expect(parsed.segments).toEqual([])
    expect(parsed.errors[0]?.message).toContain('maximum placeholder count')
  })
})

// #endregion

// #region Template renderer coverage

describe('template renderer', () => {
  test('renders markdown template', () => {
    const rendered = renderTemplate('Hi {{ name }}', { name: 'John' })
    expect(rendered.errors).toHaveLength(0)
    expect(rendered.output).toBe('Hi John')
  })

  test('renders lexically scanned brace expressions', () => {
    const rendered = renderTemplate('A {{ /* }} */ ({ value: "}}" }).value }} B', {})

    expect(rendered).toEqual({ output: 'A }} B', errors: [] })
  })

  test('keeps delimiter runs inside regex and template literals', () => {
    expect(renderTemplate('A {{ /}}/.source }} B', {}).output).toBe('A }} B')
    expect(renderTemplate('A {{ `}}` }} B', {}).output).toBe('A }} B')
  })

  test('renders dollar and brace expressions together', () => {
    const rendered = renderTemplate(
      'Hi $user.name! Total: {{ $price * $quantity }}; $$5 stays literal.',
      {
        $user: { name: 'Ada' },
        $price: 12,
        $quantity: 3,
      },
      { syntax: 'both' },
    )

    expect(rendered).toEqual({
      output: 'Hi Ada! Total: 36; $5 stays literal.',
      errors: [],
    })
  })

  test('reports malformed dollar interpolation as a parse error', () => {
    const rendered = renderTemplate('Value: $items[', { $items: [] }, { syntax: 'dollar' })

    expect(rendered.output).toBe('Value: ')
    expect(rendered.errors).toHaveLength(1)
    expect(rendered.errors[0]?.kind).toBe('parse')
  })

  test('captures unterminated lexical constructs in dollar interpolation', () => {
    const parsed = parseTemplate('Value: $format("unterminated', { syntax: 'dollar' })
    const rendered = renderTemplate(
      'Value: $format("unterminated',
      { $format: String },
      { syntax: 'dollar' },
    )

    expect(parsed.segments[1]).toMatchObject({
      type: 'expression',
      expr: '$format("unterminated',
    })
    expect(rendered.output).toBe('Value: ')
    expect(rendered.errors[0]?.kind).toBe('lex')
  })

  test('renders html-safe values when format=html', () => {
    const rendered = renderTemplate('<p>{{ html }}</p>', { html: '<b>X</b>' }, { format: 'html' })
    expect(rendered.errors).toHaveLength(0)
    expect(rendered.output).toBe('<p>&lt;b&gt;X&lt;/b&gt;</p>')
  })

  test('collects eval errors in non-strict mode', () => {
    const rendered = renderTemplate('A {{ unknown }} B', {})
    expect(rendered.errors).toHaveLength(1)
    expect(rendered.output).toBe('A  B')
    expect(rendered.errors[0]?.kind).toBe('eval')
  })

  test('stops in strict mode on first error', () => {
    const rendered = renderTemplate('A {{ unknown }} B {{ 1 + 1 }}', {}, { strict: true })
    expect(rendered.errors).toHaveLength(1)
    expect(rendered.output).toBe('A ')
  })

  test('forwards eval options to expression rendering', () => {
    const rendered = renderTemplate(
      'Hi {{ format(name) }}',
      {
        name: 'Ada',
        format: (value: string) => value.toUpperCase(),
      },
      {
        evalOptions: { isCallableAllowed: allowAllCalls },
      },
    )

    expect(rendered.errors).toHaveLength(0)
    expect(rendered.output).toBe('Hi ADA')
  })

  test('compileTemplate supports repeated rendering', () => {
    const compiled = compileTemplate('Hi {{ name }}')

    expect(compiled.render({ name: 'Ada' }).output).toBe('Hi Ada')
    expect(compiled.render({ name: 'Linus' }).output).toBe('Hi Linus')
  })

  test('compileTemplate reuses baked eval options', () => {
    const compiled = compileTemplate('Hi {{ format(name) }}', {
      evalOptions: { isCallableAllowed: allowAllCalls },
    })

    expect(
      compiled.render({
        name: 'Ada',
        format: (value: string) => value.toUpperCase(),
      }).output,
    ).toBe('Hi ADA')
  })

  test('compiled templates accept layered environments and committed variables', () => {
    const values = { count: 1 }
    const environment = createEvaluationEnvironment({
      data: { step: 2 },
      variables: createBindingStore(values),
    })
    const compiled = compileTemplate('{{ count += step }} / {{ count }}', {
      evalOptions: { writes: 'commit' },
    })

    expect(compiled.render(environment).output).toBe('3 / 3')
    expect(values.count).toBe(3)
  })

  test('template compilation rejects transaction writes', () => {
    expect(() =>
      compileTemplate('{{ count += 1 }}', { evalOptions: { writes: 'transaction' } }),
    ).toThrow('does not support')
  })

  test('compileTemplate surfaces precomputed parse errors during rendering', () => {
    const compiled = compileTemplate('A {{ value + }} B')
    const rendered = compiled.render({ value: 1 })

    expect(rendered.output).toBe('A  B')
    expect(rendered.errors).toHaveLength(1)
    expect(rendered.errors[0]?.kind).toBe('parse')
  })

  test('applies template parse budgets during rendering', () => {
    const rendered = renderTemplate(
      'A {{ first }} B {{ second }}',
      {
        first: 'x',
        second: 'y',
      },
      {
        maxPlaceholders: 1,
      },
    )

    expect(rendered.output).toBe('')
    expect(rendered.errors[0]?.message).toContain('maximum placeholder count')
  })

  test('counts brace and dollar placeholders against the same budget', () => {
    const rendered = renderTemplate(
      'A $first B {{ second }}',
      { $first: 'x', second: 'y' },
      {
        syntax: 'both',
        maxPlaceholders: 1,
      },
    )

    expect(rendered.output).toBe('')
    expect(rendered.errors[0]?.message).toContain('maximum placeholder count')
  })
})

// #endregion
