import { performance } from 'node:perf_hooks'

import { allowAllCalls, compileTemplate, renderTemplate } from '../dist/esm/index.js'

// #region Benchmark cases

const BASE_OPTIONS = Object.freeze({
  evalOptions: {
    isCallableAllowed: allowAllCalls,
  },
})

const CASES = [
  {
    name: 'member-heavy-text',
    template:
      'Hello {{ user.profile.name }}, plan={{ account.plan.name }}, seats={{ account.plan.seats }}, beta={{ account.flags.beta.enabled }}.',
    context: {
      user: {
        profile: {
          name: 'Ada',
        },
      },
      account: {
        plan: {
          name: 'growth',
          seats: 12,
        },
        flags: {
          beta: {
            enabled: true,
          },
        },
      },
    },
    options: BASE_OPTIONS,
    iterations: 120_000,
    expected: 'Hello Ada, plan=growth, seats=12, beta=true.',
  },
  {
    name: 'call-heavy-text',
    template:
      'Total {{ format(sum(double(price), tax, lookup(code))) }} for {{ customer.name.toUpperCase() }}',
    context: {
      price: 12,
      tax: 3,
      code: 'starter',
      customer: {
        name: 'ada',
      },
      double: (value) => value * 2,
      sum: (...values) => values.reduce((total, value) => total + value, 0),
      lookup: (key) => ({ starter: 5 })[key] ?? 0,
      format: (value) => `$${value.toFixed(2)}`,
    },
    options: BASE_OPTIONS,
    iterations: 90_000,
    expected: 'Total $32.00 for ADA',
  },
  {
    name: 'html-escaped',
    template:
      '<article><h1>{{ title }}</h1><p>{{ body }}</p><footer>{{ author.name }}</footer></article>',
    context: {
      title: '<Admin & Co>',
      body: 'Use "quotes" & <tags>',
      author: {
        name: "O'Hara",
      },
    },
    options: {
      ...BASE_OPTIONS,
      format: 'html',
    },
    iterations: 110_000,
    expected:
      '<article><h1>&lt;Admin &amp; Co&gt;</h1><p>Use &quot;quotes&quot; &amp; &lt;tags&gt;</p><footer>O&#39;Hara</footer></article>',
  },
  {
    name: 'short-repeated',
    template: 'Count={{ count }}',
    context: { count: 42 },
    options: BASE_OPTIONS,
    iterations: 250_000,
    expected: 'Count=42',
  },
]

const DIRECT_LABEL = 'direct render'
const COMPILED_LABEL = 'compiled render'
const WARMUP_RATIO = 0.05
const SAMPLE_COUNT = 5

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
  if (actual !== expected) {
    throw new Error(`${caseName}: ${label} produced ${actual} instead of ${expected}`)
  }
}

// #endregion

// #region Benchmark execution

const rows = []

for (const benchmarkCase of CASES) {
  const { name, template, context, options, iterations, expected } = benchmarkCase
  const warmupIterations = Math.max(1_000, Math.floor(iterations * WARMUP_RATIO))
  const compileIterations = Math.max(2_000, Math.floor(iterations / 60))

  const compiled = compileTemplate(template, options)

  warmup(() => renderTemplate(template, context, options).output, warmupIterations)
  warmup(() => compiled.render(context).output, warmupIterations)
  warmup(() => compileTemplate(template, options), Math.min(compileIterations, warmupIterations))

  const direct = measure(iterations, () => renderTemplate(template, context, options).output)
  const compiledRun = measure(iterations, () => compiled.render(context).output)
  const compileOnly = measure(compileIterations, () => compileTemplate(template, options))

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

console.log('template mode benchmark')
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
