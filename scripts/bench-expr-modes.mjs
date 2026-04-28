import { performance } from 'node:perf_hooks'

import { allowAllCalls, compile, evaluate } from '../dist/esm/index.js'

// #region Benchmark cases

const EXPR_CASES = [
  {
    name: 'arithmetic-heavy',
    expression: '((a + b * c - d / e) ** 2 + (f % g) - (h << 1)) / i',
    context: { a: 3, b: 5, c: 8, d: 144, e: 3, f: 29, g: 7, h: 4, i: 5 },
    iterations: 120_000,
    expected: 3.6,
    baseline(context) {
      const { a, b, c, d, e, f, g, h, i } = context
      return ((a + b * c - d / e) ** 2 + (f % g) - (h << 1)) / i
    },
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
    baseline(context) {
      return (
        context.user.profile.metrics.primary.current +
        context.user.profile.metrics.secondary.current +
        context.account.plan.name.length +
        context.account.flags.beta.value
      )
    },
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
    baseline(context) {
      const { a, b, c, d, double, scale, sum, lookup, math } = context
      return sum(double(a), scale(b), math.max(c, d), lookup('key'))
    },
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
    baseline(context) {
      const { user, stats, total, items, format } = context
      return `user:${user.name}|count:${stats.count}|total:${format(total)}|first:${items[0]?.label ?? 'none'}`
    },
  },
  {
    name: 'short-repeated',
    expression: 'count + 1',
    context: { count: 41 },
    iterations: 300_000,
    expected: 42,
    baseline(context) {
      return context.count + 1
    },
  },
  {
    name: 'hack-pipe-transform',
    expression: '"  ada  " |> trim(%) |> upper(%) |> suffix(%, marker)',
    context: {
      marker: '!',
      trim: (value) => value.trim(),
      upper: (value) => value.toUpperCase(),
      suffix: (value, markerValue) => `${value}${markerValue}`,
    },
    iterations: 90_000,
    expected: 'ADA!',
    baseline(context) {
      const { marker, trim, upper, suffix } = context
      return suffix(upper(trim('  ada  ')), marker)
    },
  },
  {
    name: 'hack-pipe-nested-topic',
    expression: 'input |> ((% + bonus |> double(%)) + (% |> wrap(%, prefix, suffix)).length)',
    context: {
      input: 4,
      bonus: 1,
      prefix: '<',
      suffix: '>',
      double: (value) => value * 2,
      wrap: (value, left, right) => `${left}${value}${right}`,
    },
    iterations: 80_000,
    expected: 13,
    baseline(context) {
      const { input, bonus, prefix, suffix, double, wrap } = context
      return double(input + bonus) + wrap(input, prefix, suffix).length
    },
  },
]

const ARROW_BACKEND_CASES = [
  {
    name: 'simple-closure',
    expression: '(value => value + bonus)',
    context: { bonus: 3 },
    createIterations: 220_000,
    callIterations: 500_000,
    invokeArgs: [2],
    expected: 5,
    baselineFactory(context) {
      const { bonus } = context
      return (value) => value + bonus
    },
  },
  {
    name: 'defaults-rest-destructure',
    expression: '(({ value, step = bias }, ...rest) => value + step + rest.length + extra)',
    context: { bias: 2, extra: 4 },
    createIterations: 130_000,
    callIterations: 280_000,
    invokeArgs: [{ value: 1 }, 'x', 'y'],
    expected: 9,
    baselineFactory(context) {
      const { bias, extra } = context
      return ({ value, step = bias }, ...rest) => value + step + rest.length + extra
    },
  },
  {
    name: 'pipe-topic-capture',
    expression: '2 |> (() => % + bonus)',
    context: { bonus: 5 },
    createIterations: 150_000,
    callIterations: 360_000,
    invokeArgs: [],
    expected: 7,
    baselineFactory(context) {
      const { bonus } = context
      return () => 2 + bonus
    },
  },
]

const FUNCTION_MODES = ['default', 'performance']

const DIRECT_LABEL = 'direct evaluate'
const COMPILED_LABEL = 'compiled evaluate'
const WARMUP_RATIO = 0.05
const SAMPLE_COUNT = 5
const CASE_NAME_WIDTH = 28
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

function formatRatio(value) {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: value < 0.1 ? 4 : 2,
    maximumFractionDigits: value < 0.1 ? 4 : 2,
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

function assertFunctionResult(caseName, label, candidate, invokeArgs, expected) {
  if (typeof candidate !== 'function') {
    throw new Error(`${caseName}: ${label} did not produce a function`)
  }

  const actual = candidate(...invokeArgs)
  assertExpected(caseName, `${label} invocation`, actual, expected)
}

function printTable(title, headers, rows) {
  console.log(title)
  console.log('')
  console.log(headers.join(''))
  console.log('-'.repeat(headers.join('').length))

  for (const row of rows) {
    console.log(row.join(''))
  }

  console.log('')
}

// #endregion

// #region Benchmark execution

const exprRows = []

for (const benchmarkCase of EXPR_CASES) {
  const { name, expression, context, iterations, expected, baseline } = benchmarkCase
  const warmupIterations = Math.max(1_000, Math.floor(iterations * WARMUP_RATIO))
  const compileIterations = Math.max(2_000, Math.floor(iterations / 60))

  const compiled = compile(expression, BENCH_EVAL_OPTIONS)

  warmup(() => baseline(context), warmupIterations)
  warmup(() => evaluate(expression, context, BENCH_EVAL_OPTIONS), warmupIterations)
  warmup(() => compiled.evaluate(context), warmupIterations)
  warmup(
    () => compile(expression, BENCH_EVAL_OPTIONS),
    Math.min(compileIterations, warmupIterations),
  )

  const nativeRun = measure(iterations, () => baseline(context))
  const direct = measure(iterations, () => evaluate(expression, context, BENCH_EVAL_OPTIONS))
  const compiledRun = measure(iterations, () => compiled.evaluate(context))
  const compileOnly = measure(compileIterations, () => compile(expression, BENCH_EVAL_OPTIONS))

  assertExpected(name, 'native baseline', nativeRun.lastResult, expected)
  assertExpected(name, DIRECT_LABEL, direct.lastResult, expected)
  assertExpected(name, COMPILED_LABEL, compiledRun.lastResult, expected)

  exprRows.push({
    name,
    iterations,
    nativeOps: nativeRun.opsPerSecond,
    directOps: direct.opsPerSecond,
    compiledOps: compiledRun.opsPerSecond,
    directVsNative: direct.opsPerSecond / nativeRun.opsPerSecond,
    compiledVsNative: compiledRun.opsPerSecond / nativeRun.opsPerSecond,
    compileMs: compileOnly.elapsedMs / compileIterations,
  })
}

const arrowRows = []

for (const benchmarkCase of ARROW_BACKEND_CASES) {
  const {
    name,
    expression,
    context,
    createIterations,
    callIterations,
    invokeArgs,
    expected,
    baselineFactory,
  } = benchmarkCase
  const warmupCreateIterations = Math.max(1_000, Math.floor(createIterations * WARMUP_RATIO))
  const warmupCallIterations = Math.max(1_000, Math.floor(callIterations * WARMUP_RATIO))

  warmup(() => baselineFactory(context), warmupCreateIterations)

  const baselineCreated = baselineFactory(context)
  assertFunctionResult(name, 'native create', baselineCreated, invokeArgs, expected)

  warmup(() => baselineCreated(...invokeArgs), warmupCallIterations)

  const nativeCreateRun = measure(createIterations, () => baselineFactory(context))
  const nativeInvokeRun = measure(callIterations, () => baselineCreated(...invokeArgs))

  assertFunctionResult(name, 'native create', nativeCreateRun.lastResult, invokeArgs, expected)
  assertExpected(name, 'native invoke', nativeInvokeRun.lastResult, expected)

  for (const functionMode of FUNCTION_MODES) {
    const options = {
      ...BENCH_EVAL_OPTIONS,
      functionMode,
    }
    const compiled = compile(expression, options)

    warmup(() => compiled.evaluate(context), warmupCreateIterations)

    const created = compiled.evaluate(context)
    assertFunctionResult(name, `${functionMode} create`, created, invokeArgs, expected)

    warmup(() => created(...invokeArgs), warmupCallIterations)

    const createRun = measure(createIterations, () => compiled.evaluate(context))
    const invokeRun = measure(callIterations, () => created(...invokeArgs))

    assertFunctionResult(name, `${functionMode} create`, createRun.lastResult, invokeArgs, expected)
    assertExpected(name, `${functionMode} invoke`, invokeRun.lastResult, expected)

    arrowRows.push({
      name,
      functionMode,
      nativeCreateOps: nativeCreateRun.opsPerSecond,
      nativeInvokeOps: nativeInvokeRun.opsPerSecond,
      createOps: createRun.opsPerSecond,
      callOps: invokeRun.opsPerSecond,
      createVsNative: createRun.opsPerSecond / nativeCreateRun.opsPerSecond,
      callVsNative: invokeRun.opsPerSecond / nativeInvokeRun.opsPerSecond,
    })
  }
}

console.log('expr mode benchmark')
console.log(`node ${process.version}`)
console.log(`median of ${SAMPLE_COUNT} samples per measurement`)
console.log('native V8 baseline is 1.00x')
console.log('')

const exprHeaders = [
  pad('case', CASE_NAME_WIDTH),
  pad('iterations', 12),
  pad('native ops/s', 16),
  pad('direct ops/s', 16),
  pad('compiled ops/s', 18),
  pad('direct vs v8', 14),
  pad('compiled vs v8', 16),
  pad('avg compile ms', 16),
]

printTable(
  'direct vs compiled expressions',
  exprHeaders,
  exprRows.map((row) => [
    pad(row.name, CASE_NAME_WIDTH),
    pad(row.iterations.toLocaleString('en-US'), 12),
    pad(formatOps(row.nativeOps), 16),
    pad(formatOps(row.directOps), 16),
    pad(formatOps(row.compiledOps), 18),
    pad(`${formatRatio(row.directVsNative)}x`, 14),
    pad(`${formatRatio(row.compiledVsNative)}x`, 16),
    pad(formatMilliseconds(row.compileMs), 16),
  ]),
)

const arrowHeaders = [
  pad('case', CASE_NAME_WIDTH),
  pad('backend', 14),
  pad('native create', 16),
  pad('create ops/s', 16),
  pad('create vs v8', 16),
  pad('native invoke', 16),
  pad('invoke ops/s', 16),
  pad('invoke vs v8', 16),
]

printTable(
  'arrow backend runtime (compiled expressions)',
  arrowHeaders,
  arrowRows.map((row) => [
    pad(row.name, CASE_NAME_WIDTH),
    pad(row.functionMode, 14),
    pad(formatOps(row.nativeCreateOps), 16),
    pad(formatOps(row.createOps), 16),
    pad(`${formatRatio(row.createVsNative)}x`, 16),
    pad(formatOps(row.nativeInvokeOps), 16),
    pad(formatOps(row.callOps), 16),
    pad(`${formatRatio(row.callVsNative)}x`, 16),
  ]),
)

// #endregion
