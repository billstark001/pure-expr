export const FORBIDDEN_PREFIX_IDENTIFIERS = new Set([
  'new',
  'delete',
  'yield',
  'return',
  'throw',
  'var',
  'let',
  'const',
  'function',
  'class',
])

export const FORBIDDEN_ARROW_BINDING_IDENTIFIERS = new Set([
  ...FORBIDDEN_PREFIX_IDENTIFIERS,
  'arguments',
  'super',
  'this',
])

export const FORBIDDEN_ARROW_REFERENCE_IDENTIFIERS = new Set(['arguments', 'super', 'this'])
