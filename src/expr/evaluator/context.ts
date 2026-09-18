import type { ExpressionNode } from '../node-types.js'
import { BLOCKED_PROPS } from './security.js'
import { consumeStep } from './state.js'
import {
  type BindingStore,
  type ContextFreeze,
  type ContextInputMode,
  type ContextIsolation,
  type ContextPolicy,
  DEFAULT_CONTEXT_POLICY,
  DEFAULT_CONTEXT_WRITE_MODE,
  DEFAULT_OBJECT_LITERAL_MODE,
  EVALUATION_ENVIRONMENT_BRAND,
  EVALUATION_SCOPE_BRAND,
  type EvalState,
  type EvaluationEnvironment,
  type EvaluationEnvironmentInit,
  type EvaluationInput,
  type EvaluationScope,
  type EvaluationTransactionResult,
  JSEvalError,
  type JSEvalOptions,
  type ObjectLiteralMode,
  type RuntimeEnvironment,
  type TransactionBindingStore,
} from './types.js'

const EVALUATION_ENVIRONMENT_PROTOTYPE = Object.freeze(Object.create(null) as object)

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
  context: object,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!isPlainObjectRecord(context)) {
    throw new JSEvalError(`${label} must be a plain object or null-prototype object`)
  }

  return clonePlainDataValue(context, label, new WeakMap(), new WeakSet()) as Readonly<
    Record<string, unknown>
  >
}

function deepFreezePlainData(value: unknown, seen = new WeakSet<object>()): void {
  if (!isObjectLike(value) || seen.has(value)) return
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && 'value' in descriptor) deepFreezePlainData(descriptor.value, seen)
  }
  Object.freeze(value)
}

function resolveContextPolicy(policy: ContextPolicy | undefined): {
  input: ContextInputMode
  isolation: ContextIsolation
  freeze: ContextFreeze
} {
  return {
    input: policy?.input ?? DEFAULT_CONTEXT_POLICY.input ?? 'plain-only',
    isolation: policy?.isolation ?? DEFAULT_CONTEXT_POLICY.isolation ?? 'reference',
    freeze: policy?.freeze ?? 'none',
  }
}

export function prepareContextRecord(
  context: object,
  policy: ContextPolicy | undefined,
  label: string,
): Readonly<Record<string, unknown>> {
  const resolved = resolveContextPolicy(policy)
  if (resolved.isolation === 'reference' && resolved.freeze !== 'none') {
    throw new JSEvalError('Reference context isolation cannot freeze caller-owned values')
  }
  if (resolved.isolation === 'shallow-snapshot' && resolved.freeze === 'deep') {
    throw new JSEvalError('Shallow context snapshots cannot deep-freeze borrowed nested values')
  }
  const referenced = prepareReferenceContext(context, resolved.input, label)

  let prepared: Readonly<Record<string, unknown>>
  if (resolved.isolation === 'reference') prepared = referenced
  else if (resolved.isolation === 'shallow-snapshot') {
    prepared = copyOwnEnumerableToNullPrototype(context)
  } else {
    prepared = copyPlainDataRootToNullPrototype(context, label)
  }

  if (resolved.freeze === 'shallow') Object.freeze(prepared)
  else if (resolved.freeze === 'deep') deepFreezePlainData(prepared)
  return prepared
}

export function prepareReferenceContext(
  context: object,
  input: ContextInputMode,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!isObjectLike(context)) throw new JSEvalError(`${label} must be an object`)
  if (input === 'plain-only' && !isPlainObjectRecord(context)) {
    throw new JSEvalError(`${label} must be a plain object or null-prototype object`)
  }
  if (input === 'own-properties' && typeof context !== 'object') {
    throw new JSEvalError(`${label} must be an object with own properties`)
  }
  return context as Readonly<Record<string, unknown>>
}

export function createBindingStore(
  values: Record<string, unknown> = createNullPrototypeRecord(),
): BindingStore {
  return {
    has: (name) => Object.prototype.hasOwnProperty.call(values, name),
    get: (name) => values[name],
    set: (name, value) => {
      values[name] = value
    },
    delete: (name) => delete values[name],
  }
}

export function createEvaluationEnvironment(
  init: EvaluationEnvironmentInit = {},
): EvaluationEnvironment {
  return Object.freeze(
    Object.assign(Object.create(EVALUATION_ENVIRONMENT_PROTOTYPE), {
      ...init,
      dataPolicy: init.dataPolicy ? Object.freeze({ ...init.dataPolicy }) : undefined,
      capabilitiesPolicy: init.capabilitiesPolicy
        ? Object.freeze({ ...init.capabilitiesPolicy })
        : undefined,
      [EVALUATION_ENVIRONMENT_BRAND]: true as const,
    }),
  ) as EvaluationEnvironment
}

export function isEvaluationEnvironment(input: EvaluationInput): input is EvaluationEnvironment {
  return (
    isObjectLike(input) &&
    (Object.getPrototypeOf(input) === EVALUATION_ENVIRONMENT_PROTOTYPE ||
      (input as Partial<EvaluationEnvironment>)[EVALUATION_ENVIRONMENT_BRAND] === true)
  )
}

function createTransactionStore(
  readBase: BindingStore,
  commitTarget: BindingStore,
): TransactionBindingStore {
  const pending = new Map<string, unknown>()
  let status: TransactionBindingStore['status'] = 'pending'
  const assertPending = () => {
    if (status !== 'pending') throw new JSEvalError(`Transaction is already ${status}`)
  }

  return {
    has: (name) => pending.has(name) || readBase.has(name),
    get: (name) => (pending.has(name) ? pending.get(name) : readBase.get(name)),
    set: (name, value) => {
      assertPending()
      pending.set(name, value)
    },
    get changes() {
      return new Map(pending)
    },
    get status() {
      return status
    },
    commit() {
      assertPending()
      for (const [name, value] of pending) commitTarget.set(name, value)
      status = 'committed'
    },
    rollback() {
      assertPending()
      pending.clear()
      status = 'rolled-back'
    },
  }
}

function recordStore(record: object): BindingStore {
  return createBindingStore(record as Record<string, unknown>)
}

export function createRuntimeEnvironment(
  inputs: readonly EvaluationInput[],
  opts: Readonly<JSEvalOptions>,
): RuntimeEnvironment {
  const data: Array<Readonly<Record<string, unknown>>> = []
  const capabilities: Array<Readonly<Record<string, unknown>>> = []
  let variables: BindingStore | undefined
  let legacyWriteTarget: object | undefined

  for (const [index, input] of inputs.entries()) {
    const label = index === 0 ? 'Base evaluation context' : 'Evaluation context'
    if (isEvaluationEnvironment(input)) {
      if (input.capabilities) {
        capabilities.push(
          prepareContextRecord(
            input.capabilities,
            input.capabilitiesPolicy ?? {
              input: 'allow',
              isolation: 'reference',
              freeze: 'none',
            },
            `${label} capabilities`,
          ),
        )
      }
      if (input.data) {
        data.push(prepareContextRecord(input.data, input.dataPolicy ?? opts.contextPolicy, label))
      }
      if (input.variables) variables = input.variables
    } else {
      data.push(prepareContextRecord(input, opts.contextPolicy, label))
      legacyWriteTarget = input
    }
  }

  const writes = opts.writes ?? DEFAULT_CONTEXT_WRITE_MODE
  let transaction: TransactionBindingStore | undefined
  if (!variables && legacyWriteTarget && (writes === 'commit' || writes === 'transaction')) {
    const target = recordStore(legacyWriteTarget)
    if (writes === 'commit') {
      const isolation = resolveContextPolicy(opts.contextPolicy).isolation
      if (isolation !== 'reference') {
        throw new JSEvalError('commit writes require reference context isolation')
      }
      variables = target
    } else {
      const snapshot = data[data.length - 1] ?? legacyWriteTarget
      transaction = createTransactionStore(recordStore(snapshot), target)
      variables = transaction
    }
  } else if (writes === 'transaction' && variables) {
    transaction = createTransactionStore(variables, variables)
    variables = transaction
  }

  if ((writes === 'commit' || writes === 'transaction') && !variables) {
    throw new JSEvalError(`${writes} writes require a variable binding store`)
  }

  return { data, capabilities, variables, writes, transaction }
}

export function completeEvaluation(
  value: unknown,
  environment: RuntimeEnvironment,
): unknown | EvaluationTransactionResult {
  if (environment.writes !== 'transaction') return value
  const transaction = environment.transaction!
  return {
    value,
    get changes() {
      return transaction.changes
    },
    get status() {
      return transaction.status
    },
    commit: () => transaction.commit(),
    rollback: () => transaction.rollback(),
  }
}

export function createRootScope(environment: RuntimeEnvironment): EvaluationScope {
  return {
    [EVALUATION_SCOPE_BRAND]: true,
    environment,
    locals: createNullPrototypeRecord(),
    hasLocalBindings: false,
  }
}

export function createChildScope(
  parent: EvaluationScope,
  names: readonly string[],
  initialValue: unknown = undefined,
): EvaluationScope {
  const locals = createNullPrototypeRecord()
  for (const name of names) locals[name] = initialValue
  const retainedParent = parent.parent || parent.hasLocalBindings ? parent : undefined
  return {
    [EVALUATION_SCOPE_BRAND]: true,
    environment: parent.environment,
    locals,
    hasLocalBindings: names.length > 0,
    parent: retainedParent,
  }
}

export function createLocalScope(
  environment: RuntimeEnvironment,
  locals: Record<string, unknown>,
): EvaluationScope {
  return {
    [EVALUATION_SCOPE_BRAND]: true,
    environment,
    locals,
    hasLocalBindings: true,
  }
}

export function defineLocalBinding(scope: EvaluationScope, name: string, value: unknown): void {
  scope.locals[name] = value
  scope.hasLocalBindings = true
}

export function resolveScopeBinding(scope: EvaluationScope, name: string): unknown {
  for (let current: EvaluationScope | undefined = scope; current; current = current.parent) {
    if (Object.prototype.hasOwnProperty.call(current.locals, name)) return current.locals[name]
  }
  const { variables, data, capabilities } = scope.environment
  if (variables?.has(name)) return variables.get(name)
  const directContext = scope.environment.directContext
  if (directContext) {
    if (Object.prototype.hasOwnProperty.call(directContext, name)) return directContext[name]
    throw new JSEvalError(`'${name}' is not defined`)
  }
  for (let index = data.length - 1; index >= 0; index -= 1) {
    if (Object.prototype.hasOwnProperty.call(data[index], name)) return data[index][name]
  }
  for (let index = capabilities.length - 1; index >= 0; index -= 1) {
    if (Object.prototype.hasOwnProperty.call(capabilities[index], name)) {
      return capabilities[index][name]
    }
  }
  throw new JSEvalError(`'${name}' is not defined`)
}

export function assignScopeBinding(scope: EvaluationScope, name: string, value: unknown): unknown {
  for (let current: EvaluationScope | undefined = scope; current; current = current.parent) {
    if (Object.prototype.hasOwnProperty.call(current.locals, name)) {
      current.locals[name] = value
      return value
    }
  }

  if (BLOCKED_PROPS.has(name)) {
    throw new JSEvalError(`Context binding '${name}' is not writable`)
  }

  const { environment } = scope
  if (environment.writes === 'deny') {
    throw new JSEvalError('Context writes are not enabled')
  }
  if (environment.writes === 'overlay') {
    scope.locals[name] = value
    scope.hasLocalBindings = true
    return value
  }
  if (!environment.variables) {
    throw new JSEvalError('Context writes require a variable binding store')
  }
  environment.variables.set(name, value)
  return value
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
  node: ExpressionNode,
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
