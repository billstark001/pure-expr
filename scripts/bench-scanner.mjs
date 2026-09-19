import { performance } from 'node:perf_hooks'

import {
  parseBindingPattern,
  parseExpression,
  parseIterationClause,
  scanBindingPattern,
  scanExpression,
} from '../dist/esm/index.js'

const SAMPLE_COUNT = 7

const stopAtOf = ({ token, depth }) =>
  depth === 0 && token.kind === 'identifier' && token.value === 'of'

const cases = [
  {
    name: 'strict expression parse',
    iterations: 60_000,
    run: () => parseExpression('user?.profile.items[0]?.label ?? fallback'),
  },
  {
    name: 'complete expression scan',
    iterations: 60_000,
    run: () => scanExpression('user?.profile.items[0]?.label ?? fallback'),
  },
  {
    name: 'host interpolation scan',
    iterations: 80_000,
    run: () =>
      scanExpression('You are $user.profile.name, welcome!', {
        start: 8,
        profile: 'interpolation',
      }),
  },
  {
    name: 'incomplete rollback scan',
    iterations: 80_000,
    run: () => scanExpression('user.profile.name +', { incomplete: 'rollback' }),
  },
  {
    name: 'binding pattern parse',
    iterations: 55_000,
    run: () => parseBindingPattern('{ id, values: [first, ...rest], limit = fallback }'),
  },
  {
    name: 'binding before of scan',
    iterations: 65_000,
    run: () => scanBindingPattern('[item, index] of entries', { boundary: stopAtOf }),
  },
  {
    name: 'iteration clause parse',
    iterations: 45_000,
    run: () => parseIterationClause('[item, index] of entries.filter(active)'),
  },
]

function median(values) {
  const sorted = values.slice().sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

function measure(benchmarkCase) {
  for (let index = 0; index < 2_000; index += 1) benchmarkCase.run()

  const samples = []
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const startedAt = performance.now()
    for (let index = 0; index < benchmarkCase.iterations; index += 1) benchmarkCase.run()
    samples.push(performance.now() - startedAt)
  }

  const elapsedMs = median(samples)
  return {
    elapsedMs,
    operationsPerSecond: benchmarkCase.iterations / (elapsedMs / 1_000),
  }
}

const rows = cases.map((benchmarkCase) => ({
  name: benchmarkCase.name,
  iterations: benchmarkCase.iterations,
  ...measure(benchmarkCase),
}))

console.log('parser and scanner throughput benchmark')
console.log(`node ${process.version}; median of ${SAMPLE_COUNT} samples`)
console.log('')
console.log(
  `${'case'.padEnd(28)}${'iterations'.padStart(12)}${'ops/s'.padStart(16)}${'sample ms'.padStart(14)}`,
)
console.log('-'.repeat(70))
for (const row of rows) {
  console.log(
    `${row.name.padEnd(28)}${row.iterations.toLocaleString('en-US').padStart(12)}${Math.round(
      row.operationsPerSecond,
    )
      .toLocaleString('en-US')
      .padStart(16)}${row.elapsedMs.toFixed(1).padStart(14)}`,
  )
}
