import { performance } from 'node:perf_hooks'

import { compile, createBindingStore, createEvaluationEnvironment } from '../dist/esm/index.js'

const SAMPLE_COUNT = 5
const WARMUP_RATIO = 0.05
const NAME_WIDTH = 28

function measure(iterations, fn, beforeSample) {
  let lastResult
  const samples = []

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    beforeSample?.()
    const startedAt = performance.now()
    for (let index = 0; index < iterations; index += 1) lastResult = fn()
    samples.push(performance.now() - startedAt)
  }

  samples.sort((left, right) => left - right)
  const elapsedMs = samples[Math.floor(samples.length / 2)]
  return { lastResult, opsPerSecond: iterations / (elapsedMs / 1000) }
}

function warmup(iterations, fn) {
  for (let index = 0; index < iterations; index += 1) fn()
}

function runCase(benchmarkCase) {
  const warmupIterations = Math.max(1_000, Math.floor(benchmarkCase.iterations * WARMUP_RATIO))
  warmup(warmupIterations, benchmarkCase.run)
  const result = measure(benchmarkCase.iterations, benchmarkCase.run, benchmarkCase.beforeSample)
  if (!Object.is(result.lastResult, benchmarkCase.expected)) {
    throw new Error(
      `${benchmarkCase.name} produced ${String(result.lastResult)} instead of ${String(benchmarkCase.expected)}`,
    )
  }
  return { ...benchmarkCase, ...result }
}

function formatOps(value) {
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

function formatRatio(value) {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function pad(value, width) {
  return String(value).padEnd(width, ' ')
}

function printGroup(title, cases) {
  const rows = cases.map(runCase)
  const baseline = rows[0].opsPerSecond
  console.log(title)
  console.log('')
  console.log(
    `${pad('mode', NAME_WIDTH)}${pad('iterations', 12)}${pad('ops/s', 16)}${pad('vs first', 12)}`,
  )
  console.log('-'.repeat(NAME_WIDTH + 12 + 16 + 12))
  for (const row of rows) {
    console.log(
      `${pad(row.name, NAME_WIDTH)}${pad(row.iterations.toLocaleString('en-US'), 12)}${pad(formatOps(row.opsPerSecond), 16)}${pad(`${formatRatio(row.opsPerSecond / baseline)}x`, 12)}`,
    )
  }
  console.log('')
}

console.log('context policy benchmark')
console.log(`node ${process.version}`)
console.log(`median of ${SAMPLE_COUNT} samples per measurement`)
console.log('the first row in each table is 1.00x')
console.log('')

const smallContext = { left: 20, right: 21, nested: { value: 1 } }
const smallSource = 'left + right + nested.value'
const smallIterations = 300_000

const reference = compile(smallSource)
const shallow = compile(smallSource, {
  contextPolicy: { isolation: 'shallow-snapshot' },
})
const shallowFrozen = compile(smallSource, {
  contextPolicy: { isolation: 'shallow-snapshot', freeze: 'shallow' },
})
const deep = compile(smallSource, {
  contextPolicy: { isolation: 'deep-snapshot' },
})
const deepFrozen = compile(smallSource, {
  contextPolicy: { isolation: 'deep-snapshot', freeze: 'deep' },
})
const referenceEnvironment = createEvaluationEnvironment({ data: smallContext })
const deepEnvironment = createEvaluationEnvironment({
  data: smallContext,
  dataPolicy: { isolation: 'deep-snapshot', freeze: 'deep' },
})

printGroup('small context isolation (compiled)', [
  {
    name: 'reference record',
    iterations: smallIterations,
    expected: 42,
    run: () => reference.evaluate(smallContext),
  },
  {
    name: 'reference environment',
    iterations: smallIterations,
    expected: 42,
    run: () => reference.evaluate(referenceEnvironment),
  },
  {
    name: 'shallow snapshot',
    iterations: smallIterations,
    expected: 42,
    run: () => shallow.evaluate(smallContext),
  },
  {
    name: 'shallow + freeze',
    iterations: smallIterations,
    expected: 42,
    run: () => shallowFrozen.evaluate(smallContext),
  },
  {
    name: 'deep snapshot',
    iterations: 100_000,
    expected: 42,
    run: () => deep.evaluate(smallContext),
  },
  {
    name: 'deep + freeze',
    iterations: 100_000,
    expected: 42,
    run: () => deepFrozen.evaluate(smallContext),
  },
  {
    name: 'deep frozen environment',
    iterations: 100_000,
    expected: 42,
    run: () => reference.evaluate(deepEnvironment),
  },
])

const layeredSource = 'left + right + count'
const layeredExpression = compile(layeredSource)
const flatLayeredContext = { left: 20, right: 21, count: 1 }
const dataOnlyEnvironment = createEvaluationEnvironment({ data: flatLayeredContext })
const dataCapabilitiesEnvironment = createEvaluationEnvironment({
  data: { left: 20, count: 1 },
  capabilities: { right: 21 },
})
const fullyLayeredEnvironment = createEvaluationEnvironment({
  data: { left: 20 },
  capabilities: { right: 21 },
  variables: createBindingStore({ count: 1 }),
})

printGroup('layered environment lookup (compiled)', [
  {
    name: 'flat record',
    iterations: smallIterations,
    expected: 42,
    run: () => layeredExpression.evaluate(flatLayeredContext),
  },
  {
    name: 'data-only environment',
    iterations: smallIterations,
    expected: 42,
    run: () => layeredExpression.evaluate(dataOnlyEnvironment),
  },
  {
    name: 'data + capabilities',
    iterations: 250_000,
    expected: 42,
    run: () => layeredExpression.evaluate(dataCapabilitiesEnvironment),
  },
  {
    name: 'data + capabilities + vars',
    iterations: 250_000,
    expected: 42,
    run: () => layeredExpression.evaluate(fullyLayeredEnvironment),
  },
])

const wideContext = { nested: { value: 1 } }
for (let index = 0; index < 64; index += 1) wideContext[`key${index}`] = index
const wideSource = 'key0 + key63 + nested.value'
const wideReference = compile(wideSource)
const wideShallow = compile(wideSource, {
  contextPolicy: { isolation: 'shallow-snapshot' },
})
const wideDeep = compile(wideSource, {
  contextPolicy: { isolation: 'deep-snapshot' },
})

printGroup('wide context isolation, 65 root bindings (compiled)', [
  {
    name: 'reference',
    iterations: 200_000,
    expected: 64,
    run: () => wideReference.evaluate(wideContext),
  },
  {
    name: 'shallow snapshot',
    iterations: 50_000,
    expected: 64,
    run: () => wideShallow.evaluate(wideContext),
  },
  {
    name: 'deep snapshot',
    iterations: 30_000,
    expected: 64,
    run: () => wideDeep.evaluate(wideContext),
  },
])

const overlayContext = { count: 1 }
const commitContext = { count: 1 }
const transactionContext = { count: 1 }
const committedTransactionContext = { count: 1 }
const variableValues = { count: 1 }
const variableEnvironment = createEvaluationEnvironment({
  variables: createBindingStore(variableValues),
})
const overlayWrite = compile('count = 2, count + 1', { writes: 'overlay' })
const commitWrite = compile('count = 2, count + 1', { writes: 'commit' })
const transactionWrite = compile('count = 2, count + 1', { writes: 'transaction' })

printGroup('identifier writes (compiled)', [
  {
    name: 'overlay',
    iterations: 250_000,
    expected: 3,
    run: () => overlayWrite.evaluate(overlayContext),
  },
  {
    name: 'commit record',
    iterations: 250_000,
    expected: 3,
    beforeSample: () => {
      commitContext.count = 1
    },
    run: () => commitWrite.evaluate(commitContext),
  },
  {
    name: 'commit BindingStore',
    iterations: 250_000,
    expected: 3,
    beforeSample: () => {
      variableValues.count = 1
    },
    run: () => commitWrite.evaluate(variableEnvironment),
  },
  {
    name: 'transaction staged',
    iterations: 150_000,
    expected: 3,
    run: () => transactionWrite.evaluate(transactionContext).value,
  },
  {
    name: 'transaction + commit',
    iterations: 150_000,
    expected: 3,
    beforeSample: () => {
      committedTransactionContext.count = 1
    },
    run: () => {
      const result = transactionWrite.evaluate(committedTransactionContext)
      result.commit()
      return result.value
    },
  },
])
