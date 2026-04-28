import type {
  JSCallable,
  JSCallPermissionContext,
  JSCallPermissionPolicy,
} from './evaluator/types.js'

// #region Internal helpers

function compactFunctionSet(values: Array<JSCallable | undefined>): Set<JSCallable> {
  const result = new Set<JSCallable>()
  for (const value of values) {
    if (typeof value === 'function') result.add(value)
  }
  return result
}

function getOptionalFunction(holder: object, key: string): JSCallable | undefined {
  const value = (holder as Record<string, unknown>)[key]
  return typeof value === 'function' ? (value as JSCallable) : undefined
}

function isStringReceiver(value: unknown): boolean {
  return typeof value === 'string' || value instanceof String
}

function isNumberReceiver(value: unknown): boolean {
  return typeof value === 'number' || value instanceof Number
}

function isBooleanReceiver(value: unknown): boolean {
  return typeof value === 'boolean' || value instanceof Boolean
}

function isBigIntReceiver(value: unknown): boolean {
  return typeof value === 'bigint' || Object.prototype.toString.call(value) === '[object BigInt]'
}

// #endregion

// #region Safe builtin allowlists

const SAFE_MATH_FUNCTIONS = compactFunctionSet([
  Math.abs,
  Math.acos,
  Math.acosh,
  Math.asin,
  Math.asinh,
  Math.atan,
  Math.atan2,
  Math.atanh,
  Math.cbrt,
  Math.ceil,
  Math.clz32,
  Math.cos,
  Math.cosh,
  Math.exp,
  Math.expm1,
  Math.floor,
  Math.fround,
  Math.hypot,
  Math.imul,
  Math.log,
  Math.log10,
  Math.log1p,
  Math.log2,
  Math.max,
  Math.min,
  Math.pow,
  Math.round,
  Math.sign,
  Math.sin,
  Math.sinh,
  Math.sqrt,
  Math.tan,
  Math.tanh,
  Math.trunc,
])

const SAFE_NUMBER_STATIC_FUNCTIONS = compactFunctionSet([
  Number.isFinite,
  Number.isInteger,
  Number.isNaN,
  Number.isSafeInteger,
  Number.parseFloat,
  Number.parseInt,
])

const SAFE_STRING_METHODS = compactFunctionSet([
  String.prototype.at,
  String.prototype.charAt,
  getOptionalFunction(String.prototype, 'codePointAt'),
  String.prototype.endsWith,
  String.prototype.includes,
  String.prototype.indexOf,
  getOptionalFunction(String.prototype, 'isWellFormed'),
  String.prototype.lastIndexOf,
  getOptionalFunction(String.prototype, 'normalize'),
  String.prototype.padEnd,
  String.prototype.padStart,
  String.prototype.repeat,
  String.prototype.slice,
  String.prototype.startsWith,
  String.prototype.substring,
  String.prototype.toLowerCase,
  String.prototype.toString,
  getOptionalFunction(String.prototype, 'toWellFormed'),
  String.prototype.toUpperCase,
  String.prototype.trim,
  String.prototype.trimEnd,
  getOptionalFunction(String.prototype, 'trimLeft'),
  getOptionalFunction(String.prototype, 'trimRight'),
  String.prototype.trimStart,
  String.prototype.valueOf,
])

const SAFE_ARRAY_METHODS = compactFunctionSet([
  Array.prototype.at,
  getOptionalFunction(Array.prototype, 'flat'),
  Array.prototype.includes,
  Array.prototype.indexOf,
  Array.prototype.lastIndexOf,
  Array.prototype.slice,
  getOptionalFunction(Array.prototype, 'toReversed'),
  getOptionalFunction(Array.prototype, 'toSpliced'),
  getOptionalFunction(Array.prototype, 'with'),
])

const SAFE_NUMBER_METHODS = compactFunctionSet([
  Number.prototype.toExponential,
  Number.prototype.toFixed,
  Number.prototype.toPrecision,
  Number.prototype.toString,
  Number.prototype.valueOf,
])

const SAFE_BOOLEAN_METHODS = compactFunctionSet([
  Boolean.prototype.toString,
  Boolean.prototype.valueOf,
])

const SAFE_BIGINT_METHODS = compactFunctionSet([
  BigInt.prototype.toString,
  BigInt.prototype.valueOf,
])

// #endregion

// #region Public policy helpers

export const defaultCallPermissionPolicy: JSCallPermissionPolicy = (
  details: Readonly<JSCallPermissionContext>,
): boolean => {
  const { fn, thisValue } = details

  if ((thisValue === undefined || thisValue === Math) && SAFE_MATH_FUNCTIONS.has(fn)) return true
  if ((thisValue === undefined || thisValue === Number) && SAFE_NUMBER_STATIC_FUNCTIONS.has(fn))
    return true
  if (SAFE_STRING_METHODS.has(fn)) return isStringReceiver(thisValue)
  if (SAFE_ARRAY_METHODS.has(fn)) return Array.isArray(thisValue)
  if (SAFE_NUMBER_METHODS.has(fn)) return isNumberReceiver(thisValue)
  if (SAFE_BOOLEAN_METHODS.has(fn)) return isBooleanReceiver(thisValue)
  if (SAFE_BIGINT_METHODS.has(fn)) return isBigIntReceiver(thisValue)
  return false
}

// #endregion
