export const PREC = {
  COMMA: 1,
  PIPELINE: 3,
  CONDITIONAL: 4,
  NULLCOAL: 5,
  OR: 5,
  AND: 6,
  BITOR: 7,
  BITXOR: 8,
  BITAND: 9,
  EQUALITY: 10,
  RELATIONAL: 11,
  SHIFT: 12,
  ADD: 13,
  MUL: 14,
  EXP: 15,
  UNARY: 16,
  POSTFIX: 17,
} as const

export const INFIX_PREC: Record<string, number> = {
  '||': PREC.OR,
  '??': PREC.NULLCOAL,
  '&&': PREC.AND,
  '|': PREC.BITOR,
  '^': PREC.BITXOR,
  '&': PREC.BITAND,
  '==': PREC.EQUALITY,
  '!=': PREC.EQUALITY,
  '===': PREC.EQUALITY,
  '!==': PREC.EQUALITY,
  '<': PREC.RELATIONAL,
  '>': PREC.RELATIONAL,
  '<=': PREC.RELATIONAL,
  '>=': PREC.RELATIONAL,
  instanceof: PREC.RELATIONAL,
  '<<': PREC.SHIFT,
  '>>': PREC.SHIFT,
  '>>>': PREC.SHIFT,
  '+': PREC.ADD,
  '-': PREC.ADD,
  '*': PREC.MUL,
  '/': PREC.MUL,
  '%': PREC.MUL,
  '**': PREC.EXP,
  '|>': PREC.PIPELINE,
}

export const RIGHT_ASSOC = new Set(['**'])

export const FORBIDDEN_ASSIGNMENT_OPERATORS = new Set([
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '**=',
  '&=',
  '|=',
  '^=',
  '<<=',
  '>>=',
  '>>>=',
  '&&=',
  '||=',
  '??=',
])

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
