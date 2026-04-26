import { describe, expect, test } from 'vitest'
import { allowAllCalls } from '../src/expr/index.js'
import { parseTemplate, renderTemplate } from '../src/template/index.js'

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
})

// #endregion
