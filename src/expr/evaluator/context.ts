import type { JSExprNode } from '../node-types.js'
import { consumeStep } from './state.js'
import { BLOCKED_PROPS } from './security.js'
import {
  DEFAULT_OBJECT_LITERAL_MODE,
  DEFAULT_ROOT_CONTEXT_MODE,
  JSEvalError,
  type EvalState,
  type JSEvalOptions,
  type ObjectLiteralMode,
  type RootContextMode,
} from './types.js'

export function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

export function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function createNullPrototypeRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>
}

export function cloneContextRecord(
  source: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result = Object.getPrototypeOf(source) === null ? createNullPrototypeRecord() : {}
  for (const key of Object.keys(source)) result[key] = source[key]
  return result
}

function isPlainDataContainer(value: object): boolean {
  return Array.isArray(value) || isPlainObjectRecord(value)
}

function copyOwnEnumerableToNullPrototype(source: object): Record<string, unknown> {
  const result = createNullPrototypeRecord()
  const record = source as Record<string, unknown>
  for (const key of Object.keys(record)) result[key] = record[key]
  return result
}

function getOwnKeysForDataCopy(source: object, label: string): PropertyKey[] {
  try {
    return Reflect.ownKeys(source)
  } catch {
    throw new JSEvalError(`${label} could not be inspected safely`)
  }
}

function getOwnDescriptorForDataCopy(
  source: object,
  key: PropertyKey,
  label: string,
): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(source, key)
  } catch {
    throw new JSEvalError(`${label} could not be inspected safely`)
  }
}

function clonePlainDataValue(
  value: unknown,
  label: string,
  cloned: WeakMap<object, unknown>,
  visiting: WeakSet<object>,
): unknown {
  if (!isObjectLike(value)) return value

  const existing = cloned.get(value)
  if (existing !== undefined) {
    if (visiting.has(value)) {
      throw new JSEvalError(`${label} must not contain circular references`)
    }
    return existing
  }

  if (!isPlainDataContainer(value)) {
    throw new JSEvalError(
      `${label} must contain only plain objects, null-prototype objects, arrays, and primitives`,
    )
  }

  const result: unknown[] | Record<string, unknown> = Array.isArray(value)
    ? []
    : createNullPrototypeRecord()
  cloned.set(value, result)
  visiting.add(value)

  for (const key of getOwnKeysForDataCopy(value, label)) {
    if (Array.isArray(result) && key === 'length') continue

    const descriptor = getOwnDescriptorForDataCopy(value, key, label)
    if (!descriptor) continue
    if ('get' in descriptor || 'set' in descriptor) {
      throw new JSEvalError(`${label} must not contain accessor properties`)
    }

    Object.defineProperty(result, key, {
      value: clonePlainDataValue(descriptor.value, label, cloned, visiting),
      enumerable: descriptor.enumerable,
      configurable: true,
      writable: true,
    })
  }

  visiting.delete(value)
  return result
}

function copyPlainDataRootToNullPrototype(
  context: Readonly<Record<string, unknown>>,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!isPlainObjectRecord(context)) {
    throw new JSEvalError(`${label} must be a plain object or null-prototype object`)
  }

  return clonePlainDataValue(context, label, new WeakMap(), new WeakSet()) as Readonly<
    Record<string, unknown>
  >
}

export function normalizeContextRoot(
  context: Readonly<Record<string, unknown>>,
  mode: RootContextMode,
  label: string,
): Readonly<Record<string, unknown>> {
  if (mode === 'allow') return context
  if (mode === 'copy-plain-data-to-null-prototype') {
    return copyPlainDataRootToNullPrototype(context, label)
  }
  if (isPlainObjectRecord(context)) return context
  if (!isObjectLike(context)) {
    throw new JSEvalError(`${label} must be a plain object or null-prototype object`)
  }
  if (mode === 'copy-non-plain-to-null-prototype') {
    return copyOwnEnumerableToNullPrototype(context)
  }
  throw new JSEvalError(`${label} must be a plain object or null-prototype object`)
}

export function mergeContexts(
  base: Readonly<Record<string, unknown>>,
  override: Readonly<Record<string, unknown>>,
  rootMode: RootContextMode,
): Readonly<Record<string, unknown>> {
  if (rootMode === 'allow') return { ...base, ...override }

  const result = createNullPrototypeRecord()
  for (const key of Object.keys(base)) result[key] = base[key]
  for (const key of Object.keys(override)) result[key] = override[key]
  return result
}

export function getRootContextMode(opts: Readonly<JSEvalOptions>): RootContextMode {
  return opts.rootContextMode ?? DEFAULT_ROOT_CONTEXT_MODE
}

export function getObjectLiteralMode(opts: Readonly<JSEvalOptions>): ObjectLiteralMode {
  return opts.objectLiteralMode ?? DEFAULT_OBJECT_LITERAL_MODE
}

export function createObjectLiteralResult(mode: ObjectLiteralMode): Record<string, unknown> {
  return mode === 'safe' ? createNullPrototypeRecord() : {}
}

export function copySpreadProperties(
  target: Record<string, unknown>,
  source: unknown,
  node: JSExprNode,
  state: EvalState,
): void {
  const mode = getObjectLiteralMode(state.opts)

  if (source == null) return

  if (mode === 'none') {
    Object.assign(target, source)
    return
  }

  if (mode === 'plain-object-only' || mode === 'safe') {
    if (!isPlainObjectRecord(source)) {
      throw new JSEvalError(
        'Object spread source must be a plain object or null-prototype object',
        node,
      )
    }
  }

  const boxed = Object(source) as Record<string, unknown>
  for (const key of Object.keys(boxed)) {
    consumeStep(state, node)
    if (BLOCKED_PROPS.has(key)) continue
    target[key] = boxed[key]
  }
}

export function hasOwnEnumerableKeys(value: Readonly<Record<string, unknown>>): boolean {
  if (!isObjectLike(value)) return false
  return Object.keys(value).length > 0
}
