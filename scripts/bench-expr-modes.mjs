import { performance } from 'node:perf_hooks'

import { allowAllCalls, compile, evaluate } from '../dist/esm/index.js'

// #region Benchmark cases

const CASES = [
  {
    name: 'arithmetic-heavy',
    expression: '((a + b * c - d / e) ** 2 + (f % g) - (h << 1)) / i',
    context: { a: 3, b: 5, c: 8, d: 144, e: 3, f: 29, g: 7, h: 4, i: 5 },
    iterations: 120_000,
    expected: 3.6,
  },
  {
    name: 'member-access-heavy',
    expression:
      'user.profile.metrics.primary.current + user.profile.metrics.secondary.current + account.plan.name.length + account.flags.beta.value',
    context: {
      user: {
        profile: {
          metrics: {
            primary: { current: 41 },
            secondary: { current: 9 },
          },
        },
      },
      account: {
        plan: { name: 'growth' },
        flags: { beta: { value: 4 } },
      },
    },
    iterations: 120_000,
    expected: 60,
  },
  {
    name: 'call-heavy',
    expression: 'sum(double(a), scale(b), math.max(c, d), lookup("key"))',
    context: {
      a: 2,
      b: 5,
      c: 7,
      d: 11,
      double: (value) => value * 2,
      scale: (value) => value * 3,
      sum: (...values) => values.reduce((total, value) => total + value, 0),
      lookup: (key) => ({ key: 13 })[key] ?? 0,
      math: Math,
    },
    iterations: 100_000,
    expected: 43,
  },
  {
    name: 'template-literal-heavy',
    expression:
      '`user:${user.name}|count:${stats.count}|total:${format(total)}|first:${items[0]?.label ?? "none"}`',
    context: {
      user: { name: 'Ada' },
      stats: { count: 12 },
      total: 19.5,
      items: [{ label: 'starter' }],
      format: (value) => value.toFixed(2),
    },
    iterations: 90_000,
    expected: 'user:Ada|count:12|total:19.50|first:starter',
  },
  {
    name: 'short-repeated',
    expression: 'count + 1',
    context: { count: 41 },
    iterations: 300_000,
    expected: 42,
  },
]

const DIRECT_LABEL = 'direct evaluate'
const COMPILED_LABEL = 'compiled evaluate'
const WARMUP_RATIO = 0.05
const SAMPLE_COUNT = 5
const BENCH_EVAL_OPTIONS = Object.freeze({
  isCallableAllowed: allowAllCalls,
})

// #endregion

// #region Benchmark helpers

function measure(iterations, fn) {
  let lastResult
  const elapsedSamples = []

  for (let sampleIndex = 0; sampleIndex < SAMPLE_COUNT; sampleIndex += 1) {
    const startedAt = performance.now()
    for (let index = 0; index < iterations; index += 1) {
      lastResult = fn()
    }
    elapsedSamples.push(performance.now() - startedAt)
  }

  const sortedSamples = elapsedSamples.slice().sort((left, right) => left - right)
  const elapsedMs = sortedSamples[Math.floor(sortedSamples.length / 2)]

  return {
    elapsedMs,
    lastResult,
    opsPerSecond: iterations / (elapsedMs / 1000),
  }
}

function warmup(fn, iterations) {
  for (let index = 0; index < iterations; index += 1) {
    fn()
  }
}

function formatOps(opsPerSecond) {
  return opsPerSecond.toLocaleString('en-US', {
    maximumFractionDigits: 0,
  })
}

function formatMilliseconds(value) {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  })
}

function pad(value, width) {
  return String(value).padEnd(width, ' ')
}

function assertExpected(caseName, label, actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${caseName}: ${label} produced ${String(actual)} instead of ${String(expected)}`,
    )
  }
}

// #endregion

// #region Benchmark execution

const rows = []

for (const benchmarkCase of CASES) {
  const { name, expression, context, iterations, expected } = benchmarkCase
  const warmupIterations = Math.max(1_000, Math.floor(iterations * WARMUP_RATIO))
  const compileIterations = Math.max(2_000, Math.floor(iterations / 60))

  const compiled = compile(expression, BENCH_EVAL_OPTIONS)

  warmup(() => evaluate(expression, context, BENCH_EVAL_OPTIONS), warmupIterations)
  warmup(() => compiled.evaluate(context), warmupIterations)
  warmup(
    () => compile(expression, BENCH_EVAL_OPTIONS),
    Math.min(compileIterations, warmupIterations),
  )

  const direct = measure(iterations, () => evaluate(expression, context, BENCH_EVAL_OPTIONS))
  const compiledRun = measure(iterations, () => compiled.evaluate(context))
  const compileOnly = measure(compileIterations, () => compile(expression, BENCH_EVAL_OPTIONS))

  assertExpected(name, DIRECT_LABEL, direct.lastResult, expected)
  assertExpected(name, COMPILED_LABEL, compiledRun.lastResult, expected)

  rows.push({
    name,
    iterations,
    directOps: direct.opsPerSecond,
    compiledOps: compiledRun.opsPerSecond,
    speedup: compiledRun.opsPerSecond / direct.opsPerSecond,
    compileMs: compileOnly.elapsedMs / compileIterations,
  })
}

console.log('expr mode benchmark')
console.log(`node ${process.version}`)
console.log(`median of ${SAMPLE_COUNT} samples per measurement`)
console.log('')

const headers = [
  pad('case', 24),
  pad('iterations', 12),
  pad('direct ops/s', 16),
  pad('compiled ops/s', 18),
  pad('speedup', 10),
  pad('avg compile ms', 16),
]

console.log(headers.join(''))
console.log('-'.repeat(headers.join('').length))

for (const row of rows) {
  console.log(
    [
      pad(row.name, 24),
      pad(row.iterations.toLocaleString('en-US'), 12),
      pad(formatOps(row.directOps), 16),
      pad(formatOps(row.compiledOps), 18),
      pad(`${row.speedup.toFixed(2)}x`, 10),
      pad(formatMilliseconds(row.compileMs), 16),
    ].join(''),
  )
}

// #endregion
