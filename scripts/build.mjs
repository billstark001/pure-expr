import { rm } from 'node:fs/promises'

import { build } from 'esbuild'

// #region Shared build configuration

const entryPoints = ['src/index.ts', 'src/expr/index.ts', 'src/template/index.ts']
const sharedOptions = {
  entryPoints,
  outbase: 'src',
  target: 'es2015',
  platform: 'neutral',
  sourcemap: true,
  bundle: true,
  packages: 'external',
  logLevel: 'info',
}

// #endregion

// #region Emit ESM and CJS bundles

await rm('dist', { recursive: true, force: true })

await Promise.all([
  build({
    ...sharedOptions,
    outdir: 'dist/esm',
    format: 'esm',
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
  }),
  build({
    ...sharedOptions,
    outdir: 'dist/cjs',
    format: 'cjs',
    splitting: false,
    outExtension: { '.js': '.cjs' },
  }),
])

// #endregion
