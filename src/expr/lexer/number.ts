import {
  CC_0,
  CC_B_LOWER,
  CC_B_UPPER,
  CC_N_LOWER,
  CC_O_LOWER,
  CC_O_UPPER,
  CC_UNDERSCORE,
  CC_X_LOWER,
  CC_X_UPPER,
  isDecimalDigitCode,
  isIdentifierStartCode,
} from './char-codes.js'
import type { JSNumberOptions, NumberRadix } from './types.js'
import { JSLexError } from './types.js'

const DEC_DIGITS = `[0-9](?:_?[0-9])*`
const HEX_DIGITS = `[0-9a-fA-F](?:_?[0-9a-fA-F])*`
const OCT_DIGITS = `[0-7](?:_?[0-7])*`
const BIN_DIGITS = `[01](?:_?[01])*`
const DEC_INT = `(?:0|[1-9](?:_?[0-9])*)`
const EXPONENT = `[eE][+-]?${DEC_DIGITS}`
const DECIMAL = String.raw`(?:${DEC_INT}(?:\.(?:${DEC_DIGITS})?)?(?:${EXPONENT})?|\.${DEC_DIGITS}(?:${EXPONENT})?)`
const BIGINT = `(?:0[xX]${HEX_DIGITS}|0[oO]${OCT_DIGITS}|0[bB]${BIN_DIGITS}|${DEC_INT})n`

export const RX_NUMBER = new RegExp(
  `(?:${BIGINT}|0[xX]${HEX_DIGITS}|0[oO]${OCT_DIGITS}|0[bB]${BIN_DIGITS}|${DECIMAL})`,
  'y',
)

export interface NumberPolicy {
  readonly radixMask: number
  readonly bigint: boolean
  readonly separators: boolean
}

const ALL_RADICES_MASK = radixBit(2) | radixBit(8) | radixBit(10) | radixBit(16)
const DEFAULT_NUMBER_POLICY: NumberPolicy = {
  radixMask: ALL_RADICES_MASK,
  bigint: true,
  separators: true,
}

export function compileNumberPolicy(options: JSNumberOptions | undefined): NumberPolicy {
  if (!options) return DEFAULT_NUMBER_POLICY

  let radixMask = ALL_RADICES_MASK
  if (options.radices) {
    radixMask = 0
    for (const radix of options.radices) {
      if (radix !== 2 && radix !== 8 && radix !== 10 && radix !== 16) {
        throw new TypeError(`Unsupported number radix: ${String(radix)}`)
      }
      radixMask |= radixBit(radix)
    }
  }

  return {
    radixMask,
    bigint: options.bigint ?? true,
    separators: options.separators ?? true,
  }
}

export function scanNumber(src: string, pos: number, policy: NumberPolicy): string {
  RX_NUMBER.lastIndex = pos
  const match = RX_NUMBER.exec(src)
  if (!match || match[0].length === 0) {
    throw new JSLexError('Invalid number literal', pos, src)
  }

  const value = match[0]
  const end = pos + value.length
  const radix = getNumberRadix(value)
  const next = src.charCodeAt(end)

  const splitLegacyLeadingZero = value === '0' && isDecimalDigitCode(next)
  if (
    (isDecimalDigitCode(next) && !splitLegacyLeadingZero) ||
    isIdentifierStartCode(next) ||
    next === CC_UNDERSCORE
  ) {
    throw new JSLexError('Invalid number literal', pos, src)
  }

  if ((policy.radixMask & radixBit(radix)) === 0) {
    throw new JSLexError(`Base-${radix} number literals are not allowed`, pos, src)
  }

  if (!policy.bigint && value.charCodeAt(value.length - 1) === CC_N_LOWER) {
    throw new JSLexError('BigInt literals are not allowed', pos, src)
  }

  if (!policy.separators && value.indexOf('_') !== -1) {
    throw new JSLexError('Numeric separators are not allowed', pos, src)
  }

  return value
}

export function isBigIntLiteral(value: string): boolean {
  return value.charCodeAt(value.length - 1) === CC_N_LOWER
}

function getNumberRadix(value: string): NumberRadix {
  if (value.charCodeAt(0) !== CC_0) return 10

  const second = value.charCodeAt(1)
  if (second === CC_X_LOWER || second === CC_X_UPPER) return 16
  if (second === CC_O_LOWER || second === CC_O_UPPER) return 8
  if (second === CC_B_LOWER || second === CC_B_UPPER) return 2
  return 10
}

function radixBit(radix: NumberRadix): number {
  switch (radix) {
    case 2:
      return 1 << 0
    case 8:
      return 1 << 1
    case 10:
      return 1 << 2
    case 16:
      return 1 << 3
  }
}
