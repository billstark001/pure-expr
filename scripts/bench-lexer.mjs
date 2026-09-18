import { performance } from 'node:perf_hooks'

import { JSLexer } from '../dist/esm/index.js'

const SAMPLE_COUNT = 7
const WARMUP_ITERATIONS = 30
const MEASURE_ITERATIONS = 180

const EXPRESSIONS = [
  'user?.profile.metrics.primary + (fallback ?? 0)',
  'items.map(item => item.price * item.quantity).reduce((sum, value) => sum + value, 0)',
  '{ name: user.name, flags: [...defaults, ...overrides], active: true }',
  '`user:${user.name}|total:${format(total)}|first:${items[0]?.label ?? "none"}`',
  '/^[a-z][a-z0-9_-]+$/iu.test(slug) && score >= 1_000',
  '0xff + 0o755 + 0b1010 + 12.5e-2 + 9_007_199_254_740_991n',
  'input |> normalize(%) |> validate(%, schema)',
]

const DEFAULT_SOURCE = `${EXPRESSIONS.join(';\n// expression boundary\n')};\n`.repeat(80)
const WORD_OPERATOR_SOURCE = DEFAULT_SOURCE.replaceAll(' && ', ' and ')

const neverMatchRules = [
  {
    match: () => false,
    advance: () => {
      throw new Error('unreachable')
    },
  },
]

const wordOperatorRules = [
  {
    match: (source, position) =>
      source.charCodeAt(position) === 0x61 &&
      source.charCodeAt(position + 1) === 0x6e &&
      source.charCodeAt(position + 2) === 0x64,
    advance: (_source, position) => ({
      kind: 'op',
      value: '&&',
      start: position,
      end: position + 3,
    }),
  },
]

const cases = [
  { name: 'default', source: DEFAULT_SOURCE },
  { name: 'retain raw source', source: DEFAULT_SOURCE, options: { raw: true } },
  { name: 'one rule, all misses', source: DEFAULT_SOURCE, options: { rules: neverMatchRules } },
  {
    name: 'word operator rule',
    source: WORD_OPERATOR_SOURCE,
    options: { rules: wordOperatorRules },
  },
]

function median(values) {
  const sorted = values.slice().sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

function measure(source, options) {
  let tokenCount = 0

  for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
    tokenCount = new JSLexer(source, options).tokenize().length
  }

  const samples = []
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const startedAt = performance.now()
    for (let index = 0; index < MEASURE_ITERATIONS; index += 1) {
      const currentCount = new JSLexer(source, options).tokenize().length
      if (currentCount !== tokenCount) throw new Error('Lexer returned an unstable token count')
    }
    samples.push(performance.now() - startedAt)
  }

  const elapsedMs = median(samples)
  const seconds = elapsedMs / 1_000
  return {
    elapsedMs,
    mibPerSecond: (source.length * MEASURE_ITERATIONS) / seconds / 1024 / 1024,
    tokensPerSecond: (tokenCount * MEASURE_ITERATIONS) / seconds,
  }
}

function formatNumber(value) {
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

const rows = cases.map((benchmarkCase) => ({
  name: benchmarkCase.name,
  ...measure(benchmarkCase.source, benchmarkCase.options),
}))

console.log('lexer throughput benchmark')
console.log(`node ${process.version}; median of ${SAMPLE_COUNT} samples`)
console.log(`default corpus: ${DEFAULT_SOURCE.length.toLocaleString('en-US')} UTF-16 code units`)
console.log('')
console.log(
  `${'case'.padEnd(24)}${'MiB/s'.padStart(12)}${'token/s'.padStart(18)}${'sample ms'.padStart(14)}`,
)
console.log('-'.repeat(68))
for (const row of rows) {
  console.log(
    `${row.name.padEnd(24)}${row.mibPerSecond.toFixed(1).padStart(12)}${formatNumber(
      row.tokensPerSecond,
    ).padStart(18)}${row.elapsedMs.toFixed(1).padStart(14)}`,
  )
}
