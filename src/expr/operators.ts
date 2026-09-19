import type {
  AssignmentOperator,
  BinaryOperator,
  LogicalOperator,
  UnaryOperator,
  UpdateOperator,
} from 'estree'

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

export type SupportedUnaryOperator = Exclude<UnaryOperator, 'delete'>
export type SupportedUpdateOperator = UpdateOperator
export type SupportedAssignmentOperator = AssignmentOperator
export type SupportedBinaryOperator = BinaryOperator
export type SupportedLogicalOperator = LogicalOperator

export interface InfixOperatorInfo {
  readonly associativity: 'left' | 'right'
  readonly precedence: number
}

const leftAssociative = (precedence: number): InfixOperatorInfo => ({
  associativity: 'left',
  precedence,
})

export const BINARY_OPERATOR_INFO = Object.freeze({
  '|': leftAssociative(PREC.BITOR),
  '^': leftAssociative(PREC.BITXOR),
  '&': leftAssociative(PREC.BITAND),
  '==': leftAssociative(PREC.EQUALITY),
  '!=': leftAssociative(PREC.EQUALITY),
  '===': leftAssociative(PREC.EQUALITY),
  '!==': leftAssociative(PREC.EQUALITY),
  '<': leftAssociative(PREC.RELATIONAL),
  '>': leftAssociative(PREC.RELATIONAL),
  '<=': leftAssociative(PREC.RELATIONAL),
  '>=': leftAssociative(PREC.RELATIONAL),
  in: leftAssociative(PREC.RELATIONAL),
  instanceof: leftAssociative(PREC.RELATIONAL),
  '<<': leftAssociative(PREC.SHIFT),
  '>>': leftAssociative(PREC.SHIFT),
  '>>>': leftAssociative(PREC.SHIFT),
  '+': leftAssociative(PREC.ADD),
  '-': leftAssociative(PREC.ADD),
  '*': leftAssociative(PREC.MUL),
  '/': leftAssociative(PREC.MUL),
  '%': leftAssociative(PREC.MUL),
  '**': { associativity: 'right', precedence: PREC.EXP },
} satisfies Record<SupportedBinaryOperator, InfixOperatorInfo>)

export const LOGICAL_OPERATOR_INFO = Object.freeze({
  '||': leftAssociative(PREC.OR),
  '??': leftAssociative(PREC.NULLCOAL),
  '&&': leftAssociative(PREC.AND),
} satisfies Record<SupportedLogicalOperator, InfixOperatorInfo>)

export const ASSIGNMENT_OPERATOR_INFO = Object.freeze({
  '=': { kind: 'eager' },
  '+=': { kind: 'eager' },
  '-=': { kind: 'eager' },
  '*=': { kind: 'eager' },
  '/=': { kind: 'eager' },
  '%=': { kind: 'eager' },
  '**=': { kind: 'eager' },
  '<<=': { kind: 'eager' },
  '>>=': { kind: 'eager' },
  '>>>=': { kind: 'eager' },
  '|=': { kind: 'eager' },
  '^=': { kind: 'eager' },
  '&=': { kind: 'eager' },
  '||=': { kind: 'logical' },
  '&&=': { kind: 'logical' },
  '??=': { kind: 'logical' },
} satisfies Record<SupportedAssignmentOperator, { readonly kind: 'eager' | 'logical' }>)

export const UNARY_OPERATOR_INFO = Object.freeze({
  '!': { syntax: 'symbol' },
  '~': { syntax: 'symbol' },
  '+': { syntax: 'symbol' },
  '-': { syntax: 'symbol' },
  typeof: { syntax: 'keyword' },
  void: { syntax: 'keyword' },
} satisfies Record<SupportedUnaryOperator, { readonly syntax: 'keyword' | 'symbol' }>)

export const UPDATE_OPERATOR_INFO = Object.freeze({
  '++': {},
  '--': {},
} satisfies Record<SupportedUpdateOperator, object>)

function hasOwn(record: object, value: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, value)
}

export function isAssignmentOperator(value: string): value is SupportedAssignmentOperator {
  return hasOwn(ASSIGNMENT_OPERATOR_INFO, value)
}

export function isLogicalAssignmentOperator(
  value: SupportedAssignmentOperator,
): value is Extract<SupportedAssignmentOperator, '&&=' | '||=' | '??='> {
  return ASSIGNMENT_OPERATOR_INFO[value].kind === 'logical'
}

export function isBinaryOperator(value: string): value is SupportedBinaryOperator {
  return hasOwn(BINARY_OPERATOR_INFO, value)
}

export function isBinaryKeywordOperator(
  value: string,
): value is Extract<SupportedBinaryOperator, 'in' | 'instanceof'> {
  return value === 'in' || value === 'instanceof'
}

export function isLogicalOperator(value: string): value is SupportedLogicalOperator {
  return hasOwn(LOGICAL_OPERATOR_INFO, value)
}

export function isUnaryKeywordOperator(
  value: string,
): value is Extract<SupportedUnaryOperator, 'typeof' | 'void'> {
  return (
    hasOwn(UNARY_OPERATOR_INFO, value) &&
    UNARY_OPERATOR_INFO[value as SupportedUnaryOperator].syntax === 'keyword'
  )
}

export function isUnarySymbolOperator(
  value: string,
): value is Extract<SupportedUnaryOperator, '!' | '~' | '+' | '-'> {
  return (
    hasOwn(UNARY_OPERATOR_INFO, value) &&
    UNARY_OPERATOR_INFO[value as SupportedUnaryOperator].syntax === 'symbol'
  )
}

export function isUpdateOperator(value: string): value is SupportedUpdateOperator {
  return hasOwn(UPDATE_OPERATOR_INFO, value)
}

export function getInfixOperatorInfo(value: string): InfixOperatorInfo | undefined {
  if (isBinaryOperator(value)) return BINARY_OPERATOR_INFO[value]
  if (isLogicalOperator(value)) return LOGICAL_OPERATOR_INFO[value]
  return undefined
}

const STRUCTURAL_PUNCTUATORS = [
  '...',
  '|>',
  '?.',
  '=>',
  '?',
  ':',
  '.',
  ',',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ';',
] as const

const SYMBOLIC_UNARY_OPERATORS = Object.keys(UNARY_OPERATOR_INFO).filter(
  (operator) => UNARY_OPERATOR_INFO[operator as SupportedUnaryOperator].syntax === 'symbol',
)

/** Every symbolic token recognized by the default lexer, longest spelling first. */
export const LEXICAL_PUNCTUATORS: readonly string[] = Object.freeze(
  [
    ...new Set([
      ...Object.keys(BINARY_OPERATOR_INFO).filter((operator) => !isBinaryKeywordOperator(operator)),
      ...Object.keys(LOGICAL_OPERATOR_INFO),
      ...Object.keys(ASSIGNMENT_OPERATOR_INFO),
      ...SYMBOLIC_UNARY_OPERATORS,
      ...Object.keys(UPDATE_OPERATOR_INFO),
      ...STRUCTURAL_PUNCTUATORS,
    ]),
  ].sort((left, right) => right.length - left.length || left.localeCompare(right)),
)
